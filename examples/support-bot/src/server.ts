import * as Sentry from '@sentry/node';
import express from 'express';
import Stripe from 'stripe';
import { writeReply } from './answer.ts';
import { extractDetails } from './extract.ts';
import { reportBug } from './issues.ts';
import { routeTicket } from './router.ts';

Sentry.init({ dsn: process.env.SENTRY_DSN });
const stripe = new Stripe(process.env.STRIPE_KEY ?? '');
const app = express();
app.use(express.json());

app.post('/tickets', async (req, res) => {
  const { ticket, customerId } = req.body as { ticket: string; customerId: string };
  const label = await routeTicket(ticket);
  const details = await extractDetails(ticket);
  const customer = label === 'billing' ? await stripe.customers.retrieve(customerId) : null;
  const reply = await writeReply(ticket, JSON.stringify({ details, customer }));
  if (label === 'bug') await reportBug(ticket);
  res.json({ label, reply });
});

Sentry.setupExpressErrorHandler(app);
app.listen(3000);
