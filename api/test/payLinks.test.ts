import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bearer, deliver, intentEvent, signUp } from './helpers.js';

const t = () => globalThis.testApp;

async function makeLink(token: string, amountCents = 2500) {
  const res = await t()
    .api()
    .post('/v1/pay-links')
    .set(bearer(token))
    .set('Idempotency-Key', randomUUID())
    .send({ amountCents, description: 'Club dues' });
  expect(res.status).toBe(201);
  return res.body.payLink as { token: string; id: string };
}

const checkout = (linkToken: string, key = randomUUID()) =>
  t().api().post(`/v1/public/pay-links/${linkToken}/checkout`).set('Idempotency-Key', key).send({});

describe('pay links', () => {
  it('creates a link with an unguessable token and lists it', async () => {
    const { token } = await signUp(t());
    const link = await makeLink(token);
    expect(link.token.length).toBeGreaterThanOrEqual(32);
    const list = await t().api().get('/v1/pay-links').set(bearer(token));
    expect(list.body.payLinks).toHaveLength(1);
  });

  it('shows the customer the merchant name and amount, with no login', async () => {
    const { token } = await signUp(t(), 'SBU Badminton Club');
    const link = await makeLink(token, 2500);
    const res = await t().api().get(`/v1/public/pay-links/${link.token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ merchantName: 'SBU Badminton Club', amountCents: 2500, currency: 'usd', description: 'Club dues' });
  });

  it('returns 404 for an unknown link', async () => {
    const res = await t().api().get('/v1/public/pay-links/doesnotexist-0000000000');
    expect(res.status).toBe(404);
  });

  it('checkout creates a payment the merchant can see, and a double-click reuses it', async () => {
    const { token } = await signUp(t());
    const link = await makeLink(token);
    const key = randomUUID();
    const [a, b] = await Promise.all([checkout(link.token, key), checkout(link.token, key)]);
    expect(a.status).toBe(201);
    expect(b.body).toEqual(a.body);
    expect(a.body.clientSecret).toMatch(/_secret_/);

    const payments = (await t().api().get('/v1/payments').set(bearer(token))).body.payments;
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ amountCents: 2500, payLinkId: link.id, status: 'pending' });
  });

  it('the pay page sees success only after the webhook, not before', async () => {
    const { token } = await signUp(t());
    const link = await makeLink(token);
    const { paymentToken } = (await checkout(link.token)).body;

    const before = await t().api().get(`/v1/public/payments/${paymentToken}`);
    expect(before.body.status).toBe('pending');

    const [payment] = (await t().api().get('/v1/payments').set(bearer(token))).body.payments;
    await deliver(t(), intentEvent('payment_intent.succeeded', payment.stripePaymentIntentId));

    const after = await t().api().get(`/v1/public/payments/${paymentToken}`);
    expect(after.body).toEqual({ status: 'succeeded', amountCents: 2500, currency: 'usd' });
  });

  it('the public status endpoint does not leak merchant or Stripe details', async () => {
    const { token } = await signUp(t());
    const link = await makeLink(token);
    const { paymentToken } = (await checkout(link.token)).body;
    const res = await t().api().get(`/v1/public/payments/${paymentToken}`);
    expect(Object.keys(res.body).sort()).toEqual(['amountCents', 'currency', 'status']);
  });
});
