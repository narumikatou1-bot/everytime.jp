// server.js
// .env を最初に読む
import 'dotenv/config';

import express from 'express';
import Stripe from 'stripe';
import crypto from 'crypto';

const app = express();
const PORT = process.env.PORT || 3000;

// ---- helpers ------------------------------------------------
function assertEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is missing in env`);
  return v;
}
const stripe = new Stripe(assertEnv('STRIPE_SECRET_KEY'));

// APIキー保護 (WordPress→Render の内部呼び出し用)
function apiKeyGuard(req, res, next) {
  const key = req.header('X-API-KEY');
  if (!key || key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
  }
  next();
}

// Checkoutセッション作成（共通関数）
async function createCheckoutSession({ orderId, finalTotalJpy, expiresInSec }) {
  if (!orderId) throw new Error('MISSING_ORDER_ID');
  if (!Number.isInteger(finalTotalJpy) || finalTotalJpy <= 0) {
    throw new Error('INVALID_AMOUNT_JPY_INTEGER_REQUIRED');
  }

  const appBase = assertEnv('APP_BASE_URL'); // 例: https://everytime.jp

  const params = {
    mode: 'payment',
    line_items: [{
      price_data: {
        currency: 'jpy',
        product_data: { name: `Order #${orderId}` },
        unit_amount: finalTotalJpy,
      },
      quantity: 1,
    }],
    success_url: `${appBase}/payment/success?order=${encodeURIComponent(orderId)}&cs={CHECKOUT_SESSION_ID}`,
    cancel_url:  `${appBase}/payment/cancel?order=${encodeURIComponent(orderId)}`,
    client_reference_id: String(orderId),
  };
  if (expiresInSec) {
    const now = Math.floor(Date.now()/1000);
    params.expires_at = Math.min(now + expiresInSec, now + 60*60*24);
  }

  const session = await stripe.checkout.sessions.create(params, {
    idempotencyKey: `order-${orderId}`, // 二重発行対策
  });

  return { url: session.url, sessionId: session.id };
}

// --- Upstash(任意): 短縮URL（/p/:token） -----------------------
const UPSTASH_BASE = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
async function saveShort(token, target, ttlSec = 60 * 60 * 24) {
  if (!UPSTASH_BASE || !UPSTASH_TOKEN) return;
  const url = `${UPSTASH_BASE}/set/${encodeURIComponent(token)}/${encodeURIComponent(target)}?EX=${ttlSec}`;
  const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
  if (!r.ok) throw new Error('UPSTASH_SET_FAILED');
}
async function loadShort(token) {
  if (!UPSTASH_BASE || !UPSTASH_TOKEN) return null;
  const r = await fetch(`${UPSTASH_BASE}/get/${encodeURIComponent(token)}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
  });
  if (!r.ok) return null;
  const js = await r.json();
  return js.result || null;
}
function issueToken(n = 6) { // 6〜8文字程度でOK
  return crypto.randomBytes(n).toString('base64url');
}

// ---------------- Stripe Webhook（必ず raw を先に） --------------
app.post(
  '/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const sig = req.headers['stripe-signature'];
      const event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        assertEnv('STRIPE_WEBHOOK_SECRET')
      );

      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object;
          const orderId = session.client_reference_id;
          console.log('[Webhook] checkout.session.completed order=', orderId);
          // TODO: DBを「支払い済み」に更新
          break;
        }
        case 'checkout.session.expired': {
          const session = event.data.object;
          console.log('[Webhook] checkout.session.expired order=', session.client_reference_id);
          // TODO: 在庫の解放など
          break;
        }
        default:
          break;
      }
      res.json({ received: true });
    } catch (err) {
      console.error('[Webhook Error]', err.message);
      res.status(400).send(`Webhook Error: ${err.message}`);
    }
  }
);

// ---------------- ここからは通常のJSON API ----------------------
app.use(express.json());

app.get('/health', (_req, res) => res.send('ok'));

// 成功ページからの照会（任意）
app.get('/api/checkout-status', async (req, res) => {
  try {
    const { cs } = req.query;
    if (!cs) return res.status(400).json({ ok:false, error:'MISSING_CS' });
    const s = await stripe.checkout.sessions.retrieve(cs, { expand:['payment_intent'] });
    res.json({
      ok: true,
      orderId: s.client_reference_id,
      amount: s.amount_total,
      currency: s.currency,
      payment_status: s.payment_status,
      status: s.status,
    });
  } catch (e) {
    console.error('[checkout-status]', e);
    res.status(400).json({ ok:false, error: e.message });
  }
});

// ★ 新規: Checkout URL を返すAPI（WPから内部コール）
app.post('/api/orders/:orderId/checkout-url', apiKeyGuard, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { finalTotalJpy, short = false } = req.body || {};

    const { url, sessionId } = await createCheckoutSession({
      orderId,
      finalTotalJpy: Number(finalTotalJpy),
      expiresInSec: 60 * 60 * 24
    });

    if (short) {
      const token = issueToken(5);
      await saveShort(token, url, 60 * 60 * 24);
      const shortBase = process.env.APP_SHORT_BASE_URL || process.env.APP_BASE_URL;
      const shortUrl = `${shortBase}/p/${token}`;
      return res.json({ ok: true, url, shortUrl, sessionId });
    }

    res.json({ ok: true, url, sessionId });
  } catch (e) {
    console.error('[checkout-url] error', e);
    res.status(400).json({ ok:false, error: e.message || 'FAILED' });
  }
});

// 既存: SMS送信API（従来運用を残す場合）
// sendCheckoutLink.js 内のロジックで実装済み
import { sendCheckoutLink } from './sendCheckoutLink.js';
app.post('/api/orders/:orderId/send-payment', async (req, res) => {
  try {
    const { orderId } = req.params;
    const { finalTotalJpy, phoneE164 } = req.body;
    const url = await sendCheckoutLink({ orderId, finalTotalJpy, phoneE164 });
    res.json({ ok: true, url });
  } catch (e) {
    console.error('[SendPayment Error]', e);
    res.status(400).json({ ok: false, error: e.message || 'FAILED' });
  }
});

// 短縮リンク解決（SMSを継続する場合用）
app.get('/p/:token', async (req, res) => {
  try {
    const target = await loadShort(req.params.token);
    if (!target) return res.status(404).send('Not found');
    res.redirect(302, target);
  } catch {
    res.status(500).send('Error');
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
