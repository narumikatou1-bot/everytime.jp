// 1) .env を "最初に" 読み込む（これが超重要）
import 'dotenv/config';

import express from 'express';
import Stripe from 'stripe';
import { sendCheckoutLink } from './sendCheckoutLink.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Stripe SDK（Webhook検証にも使う）
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/* ---------------- WooCommerce REST helpers ---------------- */

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}
const WC_BASE_URL = mustEnv('WC_BASE_URL');         // 例: https://everytime.jp
const WC_CK = mustEnv('WC_CONSUMER_KEY');           // Woo API Key (Read/Write)
const WC_CS = mustEnv('WC_CONSUMER_SECRET');

function wcUrl(path) {
  const u = new URL(`${WC_BASE_URL.replace(/\/$/, '')}/wp-json/wc/v3${path}`);
  u.searchParams.set('consumer_key', WC_CK);
  u.searchParams.set('consumer_secret', WC_CS);
  return u.toString();
}

async function wcGetOrder(orderId) {
  const r = await fetch(wcUrl(`/orders/${orderId}`));
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Woo GET ${orderId} failed: ${r.status} ${t.slice(0,200)}`);
  }
  return r.json();
}

async function wcUpdateOrderStatus(orderId, status) {
  const r = await fetch(wcUrl(`/orders/${orderId}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Woo PUT ${orderId} failed: ${r.status} ${t.slice(0,200)}`);
  }
  return r.json();
}

/* ---------------- Stripe Webhook（必ず最初に raw で定義） ---------------- */
app.post(
  '/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const sig = req.headers['stripe-signature'];
      const event = stripe.webhooks.constructEvent(
        req.body, // ← raw body
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );

      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object;
          const orderId = parseInt(session.client_reference_id, 10);

          // ガード
          if (!orderId) break;
          if (session.mode !== 'payment') break;
          if (session.payment_status !== 'paid') break;

          // idempotency: すでに処理済み/別ステータスなら何もしない
          const current = await wcGetOrder(orderId);
          const curStatus = String(current.status || '');
          if (curStatus === 'processing' || curStatus === 'completed') {
            console.log(`[Webhook] order ${orderId} already ${curStatus}`);
          } else {
            await wcUpdateOrderStatus(orderId, 'processing');
            console.log(`[Webhook] order ${orderId} -> processing`);
          }
          break;
        }

        case 'checkout.session.expired': {
          const s = event.data.object;
          console.log('[Webhook] expired order:', s.client_reference_id);
          // 必要なら在庫解放や再送ロジック
          break;
        }

        default:
          // 必要に応じて他イベントもハンドリング
          break;
      }

      res.json({ received: true });
    } catch (err) {
      // Woo 側の一時エラー時は 500 を返すと Stripe がリトライしてくれる
      console.error('[Webhook Error]', err);
      return res.status(500).send(`Webhook Error: ${err.message}`);
    }
  }
);

/* ---------------- それ以外のAPIは JSON でOK（Webhookより下に置く） ---------------- */
app.use(express.json());

app.get('/health', (_req, res) => res.send('ok'));

// 決済ステータス照会API（成功ページから呼ぶ）
app.get('/api/checkout-status', async (req, res) => {
  try {
    const { cs } = req.query; // 例: cs_live_a1B2...
    if (!cs) return res.status(400).json({ ok:false, error:'MISSING_CS' });

    const session = await stripe.checkout.sessions.retrieve(cs, {
      expand: ['payment_intent']
    });

    res.json({
      ok: true,
      orderId: session.client_reference_id,
      amount: session.amount_total,
      currency: session.currency,
      payment_status: session.payment_status, // 'paid' | 'unpaid' | 'no_payment_required'
      status: session.status,                 // 'complete' | 'open' | 'expired'
    });
  } catch (e) {
    console.error('[checkout-status]', e);
    res.status(400).json({ ok:false, error:e.message });
  }
});

/**
 * 注文確定→支払いリンク作成→SMS送信（既存継続）
 *  POST /api/orders/1234/send-payment
 *  { "finalTotalJpy": 5980, "phoneE164": "+81xxxxxxxxx" }
 */
app.post('/api/orders/:orderId/send-payment', async (req, res) => {
  try {
    const { orderId } = req.params;
    const { finalTotalJpy, phoneE164 } = req.body;

    // ※ 本番では finalTotalJpy をサーバー側で再計算/検証して改ざん対策を！
    const url = await sendCheckoutLink({ orderId, finalTotalJpy, phoneE164 });

    res.json({ ok: true, url });
  } catch (e) {
    console.error('[SendPayment Error]', e);
    res.status(400).json({ ok: false, error: e.message || 'FAILED' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
