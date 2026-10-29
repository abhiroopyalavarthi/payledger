import 'dotenv/config';
import Stripe from 'stripe';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { StripeGateway } from './lib/stripeGateway.js';

const config = loadConfig();
const { db, sql } = createDb(config.DATABASE_URL);
const stripe = new Stripe(config.STRIPE_SECRET_KEY);

const app = await buildApp(
  { db, gateway: new StripeGateway(stripe), stripeWebhooks: stripe.webhooks, config },
  { logger: true },
);

const shutdown = async () => {
  await app.close();
  await sql.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: config.PORT, host: '0.0.0.0' });
