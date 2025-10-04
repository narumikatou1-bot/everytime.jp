import 'dotenv/config';
import express from 'express';
import Stripe from 'stripe';
import cors from 'cors';
import { sendCheckoutLink } from './sendCheckoutLink.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Webhook（順序が超重要：rawで受ける）
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const sig = req.headers['stripe-signature'];
    const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const orderId = session.client_reference_id;
        console.log('[Webhook] checkout.session.completed order=', orderId);
        // TODO: 注文を「支払い済み」に更新。必要なら完了SMS/メール送信。
        break;
      }
      case 'checkout.session.expired': {
        const session = event.data.object;
        console.log('[Webhook] checkout.session.expired order=', session.client_reference_id);
        break;
      }
      default: break;
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[Webhook Error]', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// それ以外は JSON でOK
app.use(express.json());

// WordPress から叩く前提で /api は CORS 許可
app.use('/api', cors({
  origin: ['https://everytime.jp','https://www.everytime.jp'],
  methods: ['GET','POST']
}));

app.get('/health', (_req, res) => res.send('ok'));

// 支払いリンク発行→SMS送信
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
