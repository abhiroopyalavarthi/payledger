import { describe, expect, it } from 'vitest';
import {
  bearer,
  createPayment,
  deliver,
  intentEvent,
  makeEvent,
  signPayload,
  signUp,
} from './helpers.js';

const t = () => globalThis.testApp;

async function paidSetup(amount = 2500) {
  const m = await signUp(t());
  const p = await createPayment(t(), m.token, amount);
  return { ...m, payment: p };
}

const statusOf = async (token: string, id: string) =>
  (await t().api().get(`/v1/payments/${id}`).set(bearer(token))).body.payment.status as string;

const ledgerRowCount = async () => (await t().sql`SELECT count(*)::int AS n FROM ledger_entries`)[0]!.n as number;

describe('webhook signature', () => {
  it('accepts a correctly signed event', async () => {
    const { token, payment } = await paidSetup();
    const res = await deliver(t(), intentEvent('payment_intent.succeeded', payment.stripePaymentIntentId));
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('applied');
    expect(await statusOf(token, payment.id)).toBe('succeeded');
  });

  it('rejects a tampered body with 400 and changes nothing', async () => {
    const { token, payment } = await paidSetup();
    const original = JSON.stringify(intentEvent('payment_intent.succeeded', payment.stripePaymentIntentId, 1));
    const header = signPayload(original);
    const tampered = original.replace('"amount":1', '"amount":999999');
    const res = await t()
      .api()
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', header)
      .send(tampered);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_signature');
    expect(await statusOf(token, payment.id)).toBe('pending');
  });

  it('rejects an event signed with the wrong secret', async () => {
    const { payment } = await paidSetup();
    const payload = JSON.stringify(intentEvent('payment_intent.succeeded', payment.stripePaymentIntentId));
    const res = await t()
      .api()
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', signPayload(payload, 'whsec_someone_elses_secret'))
      .send(payload);
    expect(res.status).toBe(400);
  });

  it('rejects a request with no signature header', async () => {
    const res = await t().api().post('/webhooks/stripe').set('Content-Type', 'application/json').send('{}');
    expect(res.status).toBe(400);
  });
});

describe('payment_intent events', () => {
  it('succeeded writes one balanced ledger transaction: clearing +2500, payable -2500', async () => {
    const { token, payment } = await paidSetup(2500);
    await deliver(t(), intentEvent('payment_intent.succeeded', payment.stripePaymentIntentId));
    const detail = await t().api().get(`/v1/payments/${payment.id}`).set(bearer(token));
    expect(detail.body.ledger).toHaveLength(1);
    expect(detail.body.ledger[0].entries).toEqual(
      expect.arrayContaining([
        { account: 'stripe_clearing', amountCents: 2500 },
        { account: 'merchant_payable', amountCents: -2500 },
      ]),
    );
    const balance = await t().api().get('/v1/balance').set(bearer(token));
    expect(balance.body.balance.availableCents).toBe(2500);
  });

  it('the same event delivered 5 times changes status once and writes one set of entries', async () => {
    const { token, payment } = await paidSetup();
    const event = intentEvent('payment_intent.succeeded', payment.stripePaymentIntentId);
    const outcomes = [];
    for (let i = 0; i < 5; i++) outcomes.push((await deliver(t(), event)).body.outcome);
    expect(outcomes).toEqual(['applied', 'duplicate', 'duplicate', 'duplicate', 'duplicate']);
    expect(await ledgerRowCount()).toBe(2);
    const balance = await t().api().get('/v1/balance').set(bearer(token));
    expect(balance.body.balance.availableCents).toBe(2500);
  });

  it('the same event delivered 5 times at once is still applied once', async () => {
    const { payment } = await paidSetup();
    const event = intentEvent('payment_intent.succeeded', payment.stripePaymentIntentId);
    const results = await Promise.all(Array.from({ length: 5 }, () => deliver(t(), event)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.outcome === 'applied')).toHaveLength(1);
    expect(await ledgerRowCount()).toBe(2);
  });

  it('two different succeeded events for one payment still capture once', async () => {
    const { payment } = await paidSetup();
    await deliver(t(), intentEvent('payment_intent.succeeded', payment.stripePaymentIntentId));
    const second = await deliver(t(), intentEvent('payment_intent.succeeded', payment.stripePaymentIntentId));
    expect(second.body.outcome).toBe('stale');
    expect(await ledgerRowCount()).toBe(2);
  });

  it('succeeded arriving before processing leaves the payment succeeded', async () => {
    const { token, payment } = await paidSetup();
    await deliver(t(), intentEvent('payment_intent.succeeded', payment.stripePaymentIntentId));
    const late = await deliver(t(), intentEvent('payment_intent.processing', payment.stripePaymentIntentId));
    expect(late.body.outcome).toBe('stale');
    expect(await statusOf(token, payment.id)).toBe('succeeded');
  });

  it('a late payment_failed cannot undo a success', async () => {
    const { token, payment } = await paidSetup();
    await deliver(t(), intentEvent('payment_intent.succeeded', payment.stripePaymentIntentId));
    await deliver(t(), intentEvent('payment_intent.payment_failed', payment.stripePaymentIntentId));
    expect(await statusOf(token, payment.id)).toBe('succeeded');
  });

  it('a failed card followed by a successful retry ends succeeded, captured once', async () => {
    const { token, payment } = await paidSetup();
    await deliver(t(), intentEvent('payment_intent.payment_failed', payment.stripePaymentIntentId));
    expect(await statusOf(token, payment.id)).toBe('failed');
    expect(await ledgerRowCount()).toBe(0);
    await deliver(t(), intentEvent('payment_intent.succeeded', payment.stripePaymentIntentId));
    expect(await statusOf(token, payment.id)).toBe('succeeded');
    expect(await ledgerRowCount()).toBe(2);
  });

  it('acknowledges events for payments it does not know (e.g. stripe trigger) without failing', async () => {
    const res = await deliver(t(), intentEvent('payment_intent.succeeded', 'pi_from_stripe_trigger'));
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('unknown_payment');
  });

  it('acknowledges event types it does not handle', async () => {
    const res = await deliver(t(), makeEvent('customer.created', { id: 'cus_1', object: 'customer' }));
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('ignored_event_type');
  });
});
