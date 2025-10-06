import 'dotenv/config';
import Stripe from 'stripe';
import twilio from 'twilio';
import { createShort } from './shortener.js';

function need(name){ const v=process.env[name]; if(!v) throw new Error(`${name} is missing in .env`); return v; }
function twilioClient(){ return twilio(need('TWILIO_ACCOUNT_SID'), need('TWILIO_AUTH_TOKEN')); }
function smsParams(to, body){
  if (process.env.TWILIO_MESSAGING_SERVICE_SID) return { to, body, messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID };
  if (process.env.TWILIO_FROM) return { to, body, from: process.env.TWILIO_FROM };
  throw new Error('Either TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM is required');
}

export async function sendCheckoutLink({ orderId, finalTotalJpy, phoneE164, expiresInSec }) {
  if (!orderId) throw new Error('MISSING_ORDER_ID');
  if (!Number.isInteger(finalTotalJpy) || finalTotalJpy <= 0) throw new Error('INVALID_AMOUNT_JPY_INTEGER_REQUIRED');
  if (!/^\+\d{8,15}$/.test(phoneE164)) throw new Error('INVALID_E164_PHONE');

  const stripe = new Stripe(need('STRIPE_SECRET_KEY'));
  const appBase = need('APP_BASE_URL');

  // 24h 以内で期限を設定（Stripeの最大は24h）
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = Math.min(now + (expiresInSec || 24*60*60), now + 24*60*60);

  const params = {
    mode: 'payment',
    line_items: [{
      price_data: { currency: 'jpy', product_data: { name: `Order #${orderId}` }, unit_amount: finalTotalJpy },
      quantity: 1
    }],
    success_url: `${appBase}/payment/success?order=${encodeURIComponent(orderId)}`,
    cancel_url:  `${appBase}/payment/cancel?order=${encodeURIComponent(orderId)}`,
    client_reference_id: String(orderId),
    expires_at: expiresAt
  };

  // 重複作成防止（同額・同注文IDなら同一キー）
  const idemKey = `order-${orderId}-${finalTotalJpy}`;
  const session = await stripe.checkout.sessions.create(params, { idempotencyKey: idemKey });

  // 短縮URL（Upstash）を作成。失敗時は長URLを使う
  let shortUrl = null;
  try {
    const ttlSec = Math.max(60, session.expires_at - Math.floor(Date.now()/1000));
    const token  = await createShort(session.url, ttlSec);
    if (token) {
      const base = (process.env.APP_SHORT_BASE_URL || process.env.APP_BASE_URL).replace(/\/$/, '');
      shortUrl = `${base}/p/${token}`;
    }
  } catch (e) {
    console.warn('[Shortener] fallback to long url:', e.message);
  }

  const urlForSms = shortUrl || session.url;
  const amountJpy = new Intl.NumberFormat('en-US').format(finalTotalJpy);

  // 英数・短文（1セグメント狙い）
  const body = [
    `NICOHUB ご注文 #${orderId}`,
    `決済リンク: ${urlForSms}`,
    `合計: JPY ${amountJpy} / リンク期限：24時間`
  ].join('\n');

  try { await twilioClient().messages.create(smsParams(phoneE164, body)); }
  catch (err) { if (err?.code === 21608) throw new Error('Twilio trial restriction: recipient number is not verified (code 21608)'); throw err; }

  return urlForSms;
}
