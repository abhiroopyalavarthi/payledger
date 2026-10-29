import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  bearer,
  chargeRefundedEvent,
  createPayment,
  deliver,
  intentEvent,
  refundEvent,
  signUp,
} from './helpers.js';

const t = () => globalThis.testApp;

async function capturedPayment(amount = 2500) {
  const m = await signUp(t());
  const payment = await createPayment(t(), m.token, amount);
  await deliver(t(), intentEvent('payment_intent.succeeded', payment.stripePaymentIntentId, amount));
  return { ...m, payment };
}

const refund = (token: string, paymentId: string, body: object = {}, key = randomUUID()) =>
  t().api().post(`/v1/payments/${paymentId}/refunds`).set(bearer(token)).set('Idempotency-Key', key).send(body);

const detail = async (token: string, id: string) => (await t().api().get(`/v1/payments/${id}`).set(bearer(token))).body;
const balance = async (token: string) => (await t().api().get('/v1/balance').set(bearer(token))).body.balance;

describe('refunds', () => {
  it("can't refund a payment that hasn't succeeded", async () => {
    const { token } = await signUp(t());
    const p = await createPayment(t(), token);
    const res = await refund(token, p.id, { amountCents: 100 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('payment_not_refundable');
  });

  it('a partial refund stays pending until Stripe confirms it, then the balance drops', async () => {
    const { token, payment } = await capturedPayment(2500);
    const res = await refund(token, payment.id, { amountCents: 1000, reason: 'damaged' });
    expect(res.status).toBe(201);
    expect(res.body.refund).toMatchObject({ amountCents: 1000, status: 'pending' });
    expect(res.body.refund.stripeRefundId).toMatch(/^re_/);
    expect(await balance(token)).toMatchObject({ availableCents: 2500, pendingRefundsCents: 1000 });

    await deliver(t(), chargeRefundedEvent(payment.stripePaymentIntentId, 2500, 1000));
    const d = await detail(token, payment.id);
    expect(d.payment.status).toBe('partially_refunded');
    expect(d.refunds[0].status).toBe('succeeded');
    expect(await balance(token)).toMatchObject({ availableCents: 1500, pendingRefundsCents: 0 });
  });

  it('refunding the rest marks the payment refunded and the balance reaches zero', async () => {
    const { token, payment } = await capturedPayment(2500);
    await refund(token, payment.id, { amountCents: 1000 });
    await deliver(t(), chargeRefundedEvent(payment.stripePaymentIntentId, 2500, 1000));
    const rest = await refund(token, payment.id); // no amount = everything left
    expect(rest.body.refund.amountCents).toBe(1500);
    await deliver(t(), chargeRefundedEvent(payment.stripePaymentIntentId, 2500, 2500));
    expect((await detail(token, payment.id)).payment.status).toBe('refunded');
    expect((await balance(token)).availableCents).toBe(0);
  });

  it('refuses a refund larger than what is left', async () => {
    const { token, payment } = await capturedPayment(2500);
    await refund(token, payment.id, { amountCents: 2000 });
    const res = await refund(token, payment.id, { amountCents: 600 });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'refund_exceeds_payment', details: { remainingCents: 500 } });
  });

  it('two refunds racing to exceed the payment: one succeeds, the other is rejected', async () => {
    const { token, payment } = await capturedPayment(2500);
    t().gateway.delayMs = 50;
    const [a, b] = await Promise.all([
      refund(token, payment.id, { amountCents: 2000 }),
      refund(token, payment.id, { amountCents: 2000 }),
    ]);
    t().gateway.delayMs = 0;
    expect([a.status, b.status].sort()).toEqual([201, 422]);
    const rows = await t().sql`SELECT count(*)::int AS n FROM refunds WHERE payment_id = ${payment.id}`;
    expect(rows[0]!.n).toBe(1);
  });

  it('a retried refund request with the same key refunds once', async () => {
    const { token, payment } = await capturedPayment(2500);
    const key = randomUUID();
    const before = t().gateway.refundsByKey.size;
    const results = await Promise.all(Array.from({ length: 5 }, () => refund(token, payment.id, { amountCents: 500 }, key)));
    expect(new Set(results.map((r) => r.body.refund.id)).size).toBe(1);
    expect(t().gateway.refundsByKey.size - before).toBe(1);
  });

  it('an older charge.refunded arriving late changes nothing', async () => {
    const { token, payment } = await capturedPayment(2500);
    await refund(token, payment.id, { amountCents: 1000 });
    await refund(token, payment.id, { amountCents: 500 });
    const newer = chargeRefundedEvent(payment.stripePaymentIntentId, 2500, 1500);
    const older = chargeRefundedEvent(payment.stripePaymentIntentId, 2500, 1000);
    await deliver(t(), newer);
    const late = await deliver(t(), older);
    expect(late.body.outcome).toBe('stale');
    expect((await balance(token)).availableCents).toBe(1000);
  });

  it('a refund confirmed by refund.updated is not counted again by charge.refunded', async () => {
    const { token, payment } = await capturedPayment(2500);
    const r = (await refund(token, payment.id, { amountCents: 700 })).body.refund;
    await deliver(t(), refundEvent('refund.updated', r.stripeRefundId, payment.stripePaymentIntentId, 700, 'succeeded'));
    await deliver(t(), chargeRefundedEvent(payment.stripePaymentIntentId, 2500, 700));
    expect((await balance(token)).availableCents).toBe(1800);
    expect((await detail(token, payment.id)).refunds).toHaveLength(1);
  });

  it('a failed refund frees up the amount again', async () => {
    const { token, payment } = await capturedPayment(2500);
    const r = (await refund(token, payment.id, { amountCents: 2500 })).body.refund;
    expect((await refund(token, payment.id, { amountCents: 1 })).status).toBe(422);
    await deliver(t(), refundEvent('refund.failed', r.stripeRefundId, payment.stripePaymentIntentId, 2500, 'failed'));
    expect((await detail(token, payment.id)).refunds[0].status).toBe('failed');
    expect((await refund(token, payment.id, { amountCents: 100 })).status).toBe(201);
    expect((await balance(token)).availableCents).toBe(2500);
  });

  it('charge.refunded before payment_intent.succeeded books the capture first', async () => {
    const { token } = await signUp(t());
    const p = await createPayment(t(), token, 3000);
    await deliver(t(), chargeRefundedEvent(p.stripePaymentIntentId, 3000, 3000));
    await deliver(t(), intentEvent('payment_intent.succeeded', p.stripePaymentIntentId, 3000));
    const d = await detail(token, p.id);
    expect(d.payment.status).toBe('refunded');
    expect(d.ledger.map((x: { kind: string }) => x.kind).sort()).toEqual(['capture', 'refund']);
    expect((await balance(token)).availableCents).toBe(0);
  });

  it('a refund made in the Stripe dashboard is still recorded in the ledger', async () => {
    const { token, payment } = await capturedPayment(2500);
    await deliver(t(), chargeRefundedEvent(payment.stripePaymentIntentId, 2500, 400));
    const d = await detail(token, payment.id);
    expect(d.refunds[0]).toMatchObject({ amountCents: 400, status: 'succeeded', reason: 'created_outside_payledger' });
    expect((await balance(token)).availableCents).toBe(2100);
  });
});
