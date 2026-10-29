import { describe, expect, it } from 'vitest';
import { postTransaction, UnbalancedTransactionError } from '../src/ledger/ledger.js';
import { ADMIN_TOKEN, adminLedgerCheck, createPayment, deliver, intentEvent, signUp } from './helpers.js';

const t = () => globalThis.testApp;

describe('ledger', () => {
  it('refuses an unbalanced transaction in code', async () => {
    const { merchantId } = await signUp(t());
    await expect(
      postTransaction(t().db, {
        ref: 'bad:1',
        merchantId,
        kind: 'test',
        description: 'does not balance',
        entries: [
          { account: 'stripe_clearing', amountCents: 100 },
          { account: 'merchant_payable', amountCents: -99 },
        ],
      }),
    ).rejects.toBeInstanceOf(UnbalancedTransactionError);
  });

  it('the database itself refuses an unbalanced transaction at commit', async () => {
    const { merchantId } = await signUp(t());
    const attempt = t().sql.begin(async (sql) => {
      const [txn] = await sql`
        INSERT INTO ledger_transactions (ref, merchant_id, kind, description)
        VALUES ('raw:1', ${merchantId}, 'test', 'raw insert') RETURNING id`;
      await sql`
        INSERT INTO ledger_entries (transaction_id, merchant_id, account, amount_cents)
        VALUES (${txn!.id}, ${merchantId}, 'stripe_clearing', 500)`;
    });
    await expect(attempt).rejects.toThrow(/does not balance/);
  });

  it('ledger entries are append-only', async () => {
    const { token } = await signUp(t());
    const p = await createPayment(t(), token);
    await deliver(t(), intentEvent('payment_intent.succeeded', p.stripePaymentIntentId));
    await expect(t().sql`UPDATE ledger_entries SET amount_cents = 1`).rejects.toThrow(/append-only/);
    await expect(t().sql`DELETE FROM ledger_entries`).rejects.toThrow(/append-only/);
  });

  it('posting the same ref twice writes it once', async () => {
    const { merchantId } = await signUp(t());
    const txn = {
      ref: 'same:1',
      merchantId,
      kind: 'test',
      description: 'twice',
      entries: [
        { account: 'a', amountCents: 50 },
        { account: 'b', amountCents: -50 },
      ],
    };
    expect(await postTransaction(t().db, txn)).toBe(true);
    expect(await postTransaction(t().db, txn)).toBe(false);
    const rows = await t().sql`SELECT count(*)::int AS n FROM ledger_entries`;
    expect(rows[0]!.n).toBe(2);
  });

  it('the admin check needs the admin token and reports ok on a healthy ledger', async () => {
    const denied = await t().api().get('/v1/admin/ledger-check').set('x-admin-token', 'wrong');
    expect(denied.status).toBe(401);

    const { token } = await signUp(t());
    const p = await createPayment(t(), token, 1234);
    await deliver(t(), intentEvent('payment_intent.succeeded', p.stripePaymentIntentId, 1234));
    const report = await adminLedgerCheck(t());
    expect(report).toMatchObject({ ok: true, unbalancedTransactions: [], balanceMismatches: [] });
    expect(ADMIN_TOKEN).toBeTruthy();
  });

  it('lists ledger transactions with their entries', async () => {
    const { token } = await signUp(t());
    const p = await createPayment(t(), token, 800);
    await deliver(t(), intentEvent('payment_intent.succeeded', p.stripePaymentIntentId, 800));
    const res = await t().api().get('/v1/ledger').set('Authorization', `Bearer ${token}`);
    expect(res.body.transactions).toHaveLength(1);
    expect(res.body.transactions[0].entries.reduce((s: number, e: { amountCents: number }) => s + e.amountCents, 0)).toBe(0);
  });
});
