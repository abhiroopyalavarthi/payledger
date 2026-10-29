import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bearer, createPayment, signUp } from './helpers.js';

const t = () => globalThis.testApp;

describe('POST /v1/payments', () => {
  it('creates a pending payment backed by a Stripe PaymentIntent', async () => {
    const { token } = await signUp(t());
    const res = await t()
      .api()
      .post('/v1/payments')
      .set(bearer(token))
      .set('Idempotency-Key', randomUUID())
      .send({ amountCents: 2500, description: 'Coffee beans' });
    expect(res.status).toBe(201);
    expect(res.body.payment).toMatchObject({ amountCents: 2500, currency: 'usd', status: 'pending' });
    expect(res.body.payment.stripePaymentIntentId).toMatch(/^pi_/);
    expect(res.body.clientSecret).toMatch(/_secret_/);
  });

  it('requires an Idempotency-Key', async () => {
    const { token } = await signUp(t());
    const res = await t().api().post('/v1/payments').set(bearer(token)).send({ amountCents: 100 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('idempotency_key_required');
  });

  it.each([
    ['a float', 25.5],
    ['zero', 0],
    ['a negative', -100],
    ['a string', '2500'],
    ['too large', 100_000_000],
  ])('rejects %s amount', async (_label, amountCents) => {
    const { token } = await signUp(t());
    const res = await t()
      .api()
      .post('/v1/payments')
      .set(bearer(token))
      .set('Idempotency-Key', randomUUID())
      .send({ amountCents });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('rejects malformed JSON with the standard error shape', async () => {
    const { token } = await signUp(t());
    const res = await t()
      .api()
      .post('/v1/payments')
      .set(bearer(token))
      .set('Idempotency-Key', randomUUID())
      .set('Content-Type', 'application/json')
      .send('{"amountCents": ');
    expect(res.status).toBe(400);
    expect(res.body.error).toHaveProperty('code');
  });
});

describe('idempotency', () => {
  it('10 concurrent requests with one key make exactly 1 payment, and all responses match', async () => {
    const { token, merchantId } = await signUp(t());
    t().gateway.delayMs = 30; // widen the race window
    const key = randomUUID();
    const intentsBefore = t().gateway.intents.size;
    const send = () =>
      t().api().post('/v1/payments').set(bearer(token)).set('Idempotency-Key', key).send({ amountCents: 2500 });

    const responses = await Promise.all(Array.from({ length: 10 }, send));
    t().gateway.delayMs = 0;

    expect(responses.map((r) => r.status)).toEqual(Array(10).fill(201));
    const bodies = responses.map((r) => JSON.stringify(r.body));
    expect(new Set(bodies).size).toBe(1);
    expect(responses.filter((r) => r.headers['idempotent-replayed'] === 'false')).toHaveLength(1);

    const rows = await t().sql`SELECT count(*)::int AS n FROM payments WHERE merchant_id = ${merchantId}`;
    expect(rows[0]!.n).toBe(1);
    expect(t().gateway.intents.size - intentsBefore).toBe(1);
  });

  it('a sequential retry gets the saved response back without calling Stripe again', async () => {
    const { token } = await signUp(t());
    const key = randomUUID();
    const first = await t().api().post('/v1/payments').set(bearer(token)).set('Idempotency-Key', key).send({ amountCents: 900 });
    const callsAfterFirst = t().gateway.intentCalls;
    const second = await t().api().post('/v1/payments').set(bearer(token)).set('Idempotency-Key', key).send({ amountCents: 900 });
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(t().gateway.intentCalls).toBe(callsAfterFirst);
  });

  it('the same key with a different body returns 422', async () => {
    const { token } = await signUp(t());
    const key = randomUUID();
    await t().api().post('/v1/payments').set(bearer(token)).set('Idempotency-Key', key).send({ amountCents: 900 });
    const res = await t().api().post('/v1/payments').set(bearer(token)).set('Idempotency-Key', key).send({ amountCents: 901 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('idempotency_key_reused');
  });

  it('keys are scoped per merchant', async () => {
    const a = await signUp(t(), 'A');
    const b = await signUp(t(), 'B');
    const key = 'shared-key-1';
    const ra = await t().api().post('/v1/payments').set(bearer(a.token)).set('Idempotency-Key', key).send({ amountCents: 100 });
    const rb = await t().api().post('/v1/payments').set(bearer(b.token)).set('Idempotency-Key', key).send({ amountCents: 100 });
    expect(ra.status).toBe(201);
    expect(rb.status).toBe(201);
    expect(ra.body.payment.id).not.toBe(rb.body.payment.id);
  });

  it('a validation error is saved too, so a retry gets the same 400', async () => {
    const { token } = await signUp(t());
    const key = randomUUID();
    const one = await t().api().post('/v1/payments').set(bearer(token)).set('Idempotency-Key', key).send({ amountCents: -1 });
    const two = await t().api().post('/v1/payments').set(bearer(token)).set('Idempotency-Key', key).send({ amountCents: -1 });
    expect(one.status).toBe(400);
    expect(two.status).toBe(400);
    expect(two.headers['idempotent-replayed']).toBe('true');
  });

  it('if Stripe fails, nothing is saved and the retry goes through', async () => {
    const { token, merchantId } = await signUp(t());
    const key = randomUUID();
    t().gateway.failNext = true;
    const failed = await t().api().post('/v1/payments').set(bearer(token)).set('Idempotency-Key', key).send({ amountCents: 700 });
    expect(failed.status).toBe(500);
    expect(failed.body.error.code).toBe('internal_error');
    const none = await t().sql`SELECT count(*)::int AS n FROM payments WHERE merchant_id = ${merchantId}`;
    expect(none[0]!.n).toBe(0);

    const retry = await t().api().post('/v1/payments').set(bearer(token)).set('Idempotency-Key', key).send({ amountCents: 700 });
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('false');
  });
});

describe('reading payments', () => {
  it('lists newest first and filters by status', async () => {
    const { token } = await signUp(t());
    const p1 = await createPayment(t(), token, 100);
    const p2 = await createPayment(t(), token, 200);
    const all = await t().api().get('/v1/payments').set(bearer(token));
    expect(all.body.payments.map((p: { id: string }) => p.id)).toEqual([p2.id, p1.id]);
    const succeeded = await t().api().get('/v1/payments?status=succeeded').set(bearer(token));
    expect(succeeded.body.payments).toEqual([]);
  });

  it("can't see another merchant's payment", async () => {
    const a = await signUp(t(), 'A');
    const b = await signUp(t(), 'B');
    const p = await createPayment(t(), a.token);
    const res = await t().api().get(`/v1/payments/${p.id}`).set(bearer(b.token));
    expect(res.status).toBe(404);
    const list = await t().api().get('/v1/payments').set(bearer(b.token));
    expect(list.body.payments).toEqual([]);
  });

  it('returns 400 for a malformed id', async () => {
    const { token } = await signUp(t());
    const res = await t().api().get('/v1/payments/not-a-uuid').set(bearer(token));
    expect(res.status).toBe(400);
  });
});
