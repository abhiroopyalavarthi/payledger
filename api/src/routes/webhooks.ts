import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';
import type { AppContext } from '../context.js';
import { AppError } from '../lib/errors.js';
import { handleStripeEvent } from '../services/webhooks.js';

export async function webhookRoutes(app: FastifyInstance, ctx: AppContext) {
  // Stripe signs the exact bytes it sends, so in this plugin scope the body
  // is kept as a raw Buffer instead of being parsed as JSON.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.post('/webhooks/stripe', async (req) => {
    const signature = req.headers['stripe-signature'];
    if (typeof signature !== 'string' || !Buffer.isBuffer(req.body)) {
      throw new AppError(400, 'bad_signature', 'Missing Stripe-Signature header or body');
    }

    let event: Stripe.Event;
    try {
      event = ctx.stripeWebhooks.constructEvent(req.body, signature, ctx.config.STRIPE_WEBHOOK_SECRET);
    } catch {
      throw new AppError(400, 'bad_signature', 'Webhook signature verification failed');
    }

    // Any throw rolls the whole thing back (event id included) and returns
    // 500, so Stripe retries later.
    const outcome = await ctx.db.transaction((tx) => handleStripeEvent(tx, event));
    req.log.info({ stripeEventId: event.id, type: event.type, outcome }, 'stripe webhook');
    return { received: true, outcome };
  });
}
