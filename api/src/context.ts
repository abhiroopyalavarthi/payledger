import type Stripe from 'stripe';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import type { PaymentGateway } from './lib/stripeGateway.js';

export interface AppContext {
  db: Db;
  gateway: PaymentGateway;
  /** Used only for webhook signature checks. */
  stripeWebhooks: Stripe['webhooks'];
  config: Pick<Config, 'JWT_SECRET' | 'ADMIN_TOKEN' | 'STRIPE_WEBHOOK_SECRET' | 'WEB_ORIGIN'>;
}
