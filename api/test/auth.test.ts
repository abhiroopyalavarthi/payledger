import { describe, expect, it } from 'vitest';
import { bearer, signUp } from './helpers.js';

const t = () => globalThis.testApp;

describe('merchant auth', () => {
  it('signs up and returns a token that works on /v1/me', async () => {
    const res = await t().api().post('/v1/merchants').send({ name: 'Bean There', email: 'Owner@Bean.com', password: 'longenough1' });
    expect(res.status).toBe(201);
    expect(res.body.merchant).toMatchObject({ name: 'Bean There', email: 'owner@bean.com' });
    expect(res.body.merchant).not.toHaveProperty('passwordHash');

    const me = await t().api().get('/v1/me').set(bearer(res.body.token));
    expect(me.status).toBe(200);
    expect(me.body.merchant.email).toBe('owner@bean.com');
  });

  it('stores a hash, not the password', async () => {
    await t().api().post('/v1/merchants').send({ name: 'A', email: 'hash@test.com', password: 'plaintext-pw' });
    const [row] = await t().sql`SELECT password_hash FROM merchants WHERE email = 'hash@test.com'`;
    expect(row!.password_hash).toMatch(/^scrypt\$/);
    expect(row!.password_hash).not.toContain('plaintext-pw');
  });

  it('rejects a duplicate email with 409', async () => {
    const body = { name: 'A', email: 'dup@test.com', password: 'longenough1' };
    await t().api().post('/v1/merchants').send(body);
    const res = await t().api().post('/v1/merchants').send(body);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('email_taken');
  });

  it('validates sign-up input with one error shape', async () => {
    const res = await t().api().post('/v1/merchants').send({ name: '', email: 'nope', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(['email', 'name', 'password']);
  });

  it('logs in with the right password and refuses the wrong one', async () => {
    await t().api().post('/v1/merchants').send({ name: 'A', email: 'login@test.com', password: 'right-password' });
    const ok = await t().api().post('/v1/auth/login').send({ email: 'LOGIN@test.com', password: 'right-password' });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTruthy();

    const bad = await t().api().post('/v1/auth/login').send({ email: 'login@test.com', password: 'wrong-password' });
    expect(bad.status).toBe(401);
    const unknown = await t().api().post('/v1/auth/login').send({ email: 'ghost@test.com', password: 'whatever' });
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(bad.body);
  });

  it('requires a valid token on merchant routes', async () => {
    expect((await t().api().get('/v1/payments')).status).toBe(401);
    expect((await t().api().get('/v1/payments').set(bearer('not.a.jwt'))).status).toBe(401);
    const { token } = await signUp(t());
    expect((await t().api().get('/v1/payments').set(bearer(token))).status).toBe(200);
  });
});
