import 'dotenv/config';
import Stripe from 'stripe';
import twilio from 'twilio';

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

  const params = {
    mode: 'payment',
    line_items: [{
      price_data: { currency: 'jpy', product_data: { name: `Order #${orderId}` }, unit_amount: finalTotalJpy },
      quantity: 1
    }],
    success_url: `${appBase}/payment/success?order=${encodeURIComponent(orderId)}`,
    cancel_url:  `${appBase}/payment/cancel?order=${encodeURIComponent(orderId)}`,
    client_reference_id: String(orderId)
  };
  if (expiresInSec) {
    const now = Math.floor(Date.now()/1000);
    params.expires_at = Math.min(now + expiresInSec, now + 86400);
  }

  // 二重作成防止（同じ注文でも金額が変われば新規扱い）
  const idemKey = `order-${orderId}-${finalTotalJpy}`;
  const session = await stripe.checkout.sessions.create(params, { idempotencyKey: idemKey });

  const body = [
    `【ニコパフ専門ならニコハブ】ご注文 #${orderId} のお支払いリンク（ストライプ）です`,
    `合計：¥${finalTotalJpy}（税込）`,
    session.url,
    `※リンクの有効期限は24時間です`
  ].join('\n');

  try { await twilioClient().messages.create(smsParams(phoneE164, body)); }
  catch (err) { if (err?.code === 21608) throw new Error('Twilio trial restriction: recipient number is not verified (code 21608)'); throw err; }

  return session.url;
}
