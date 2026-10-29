import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import Stripe from 'stripe';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import type { PaymentGateway } from '../src/lib/stripeGateway.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/payledger_test';
export const WEBHOOK_SECRET = 'whsec_test_secret_for_payledger';
export const ADMIN_TOKEN = 'admin-token-for-tests';

const stripe = new Stripe('sk_test_not_a_real_key');

/**
 * Stands in for Stripe's API. Like Stripe, it returns the same object for a
 * repeated idempotency key, so tests can see whether retries reach Stripe.
 */
export class FakeGateway implements PaymentGateway {
  intents = new Map<string, { id: string; clientSecret: string; amountCents: number }>();
  refundsByKey = new Map<string, { id: string; amountCents: number; paymentIntentId: string }>();
  intentCalls = 0;
  refundCalls = 0;
  failNext = false;
  delayMs = 0;

  private async maybeFail() {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failNext) {
      this.failNext = false;
      throw new Error('Stripe is down (simulated)');
    }
  }

  async createPaymentIntent(args: Parameters<PaymentGateway['createPaymentIntent']>[0]) {
    this.intentCalls++;
    await this.maybeFail();
    let pi = this.intents.get(args.idempotencyKey);
    if (!pi) {
      const id = `pi_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
      pi = { id, clientSecret: `${id}_secret_test`, amountCents: args.amountCents };
      this.intents.set(args.idempotencyKey, pi);
    }
    return { id: pi.id, clientSecret: pi.clientSecret };
  }

  async createRefund(args: Parameters<PaymentGateway['createRefund']>[0]) {
    this.refundCalls++;
    await this.maybeFail();
    let r = this.refundsByKey.get(args.idempotencyKey);
    if (!r) {
      r = { id: `re_${randomUUID().replaceAll('-', '').slice(0, 24)}`, amountCents: args.amountCents, paymentIntentId: args.paymentIntentId };
      this.refundsByKey.set(args.idempotencyKey, r);
    }
    return { id: r.id };
  }
}

export async function startTestApp() {
  const { db, sql } = createDb(TEST_DATABASE_URL, 20);
  const gateway = new FakeGateway();
  const app = await buildApp({
    db,
    gateway,
    stripeWebhooks: stripe.webhooks,
    config: {
      JWT_SECRET: 'test-jwt-secret-at-least-16',
      ADMIN_TOKEN,
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      WEB_ORIGIN: 'http://localhost:5173',
    },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const api = () => request(url);

  return {
    app,
    db,
    sql,
    gateway,
    api,
    async close() {
      await app.close();
      await sql.end();
    },
  };
}

export type TestApp = Awaited<ReturnType<typeof startTestApp>>;

export async function resetDb(sql: TestApp['sql']) {
  // TRUNCATE is not row-level, so the append-only trigger on ledger_entries doesn't fire.
  await sql`TRUNCATE ledger_entries, ledger_transactions, webhook_events, idempotency_keys, refunds, payments, pay_links, merchants CASCADE`;
}

let emailCounter = 0;
export async function signUp(t: TestApp, name = 'Test Shop') {
  const res = await t
    .api()
    .post('/v1/merchants')
    .send({ name, email: `shop${++emailCounter}-${Date.now()}@example.com`, password: 'correct horse battery' });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { token: res.body.token as string, merchantId: res.body.merchant.id as string };
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

export async function createPayment(t: TestApp, token: string, amountCents = 2500, key = randomUUID()) {
  const res = await t
    .api()
    .post('/v1/payments')
    .set(bearer(token))
    .set('Idempotency-Key', key)
    .send({ amountCents, description: 'Test order' });
  if (res.status !== 201) throw new Error(`create payment failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.payment as { id: string; stripePaymentIntentId: string; amountCents: number; status: string };
}

// ---- Stripe webhook events, signed with the real Stripe library ----

export function makeEvent(type: string, object: Record<string, unknown>, id = `evt_${randomUUID().replaceAll('-', '')}`) {
  return {
    id,
    object: 'event',
    api_version: '2025-01-01',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
    data: { object },
  };
}

export const intentEvent = (type: string, paymentIntentId: string, amount = 2500) =>
  makeEvent(type, { id: paymentIntentId, object: 'payment_intent', amount, currency: 'usd' });

export const chargeRefundedEvent = (paymentIntentId: string, amount: number, amountRefunded: number) =>
  makeEvent('charge.refunded', {
    id: `ch_${randomUUID().slice(0, 8)}`,
    object: 'charge',
    payment_intent: paymentIntentId,
    amount,
    amount_refunded: amountRefunded,
    refunded: amountRefunded === amount,
  });

export const refundEvent = (type: string, refundId: string, paymentIntentId: string, amount: number, status: string) =>
  makeEvent(type, { id: refundId, object: 'refund', payment_intent: paymentIntentId, amount, status });

export function signPayload(payload: string, secret = WEBHOOK_SECRET) {
  return stripe.webhooks.generateTestHeaderString({ payload, secret });
}

export async function deliver(t: TestApp, event: object) {
  const payload = JSON.stringify(event);
  return t
    .api()
    .post('/webhooks/stripe')
    .set('Content-Type', 'application/json')
    .set('Stripe-Signature', signPayload(payload))
    .send(payload);
}

export async function adminLedgerCheck(t: TestApp) {
  const res = await t.api().get('/v1/admin/ledger-check').set('x-admin-token', ADMIN_TOKEN);
  return res.body as { ok: boolean; unbalancedTransactions: unknown[]; balanceMismatches: unknown[] };
}
