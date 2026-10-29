import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { ledgerEntries, ledgerTransactions, payments, refunds } from '../db/schema.js';

// Two accounts per merchant, kept in a double-entry ledger:
//   stripe_clearing   money Stripe is holding for us        (debit-positive)
//   merchant_payable  money we owe the merchant             (credit, so negative)
// A $25 payment: clearing +2500, payable -2500. A $10 refund reverses $10.
export const ACCOUNTS = {
  clearing: 'stripe_clearing',
  payable: 'merchant_payable',
} as const;

export interface EntryInput {
  account: string;
  amountCents: number;
}

export class UnbalancedTransactionError extends Error {}

/**
 * Posts one balanced ledger transaction. Returns false (and writes nothing)
 * if a transaction with the same ref already exists, so posting is
 * idempotent on top of the webhook dedupe.
 */
export async function postTransaction(
  db: DbOrTx,
  t: { ref: string; merchantId: string; kind: string; paymentId?: string; description: string; entries: EntryInput[] },
): Promise<boolean> {
  if (t.entries.length < 2) throw new UnbalancedTransactionError('a ledger transaction needs at least two entries');
  const sum = t.entries.reduce((s, e) => s + e.amountCents, 0);
  if (sum !== 0) throw new UnbalancedTransactionError(`entries for ${t.ref} sum to ${sum}, not 0`);
  for (const e of t.entries) {
    if (!Number.isSafeInteger(e.amountCents) || e.amountCents === 0) {
      throw new UnbalancedTransactionError(`bad entry amount ${e.amountCents} in ${t.ref}`);
    }
  }

  const [txn] = await db
    .insert(ledgerTransactions)
    .values({ ref: t.ref, merchantId: t.merchantId, kind: t.kind, paymentId: t.paymentId, description: t.description })
    .onConflictDoNothing({ target: ledgerTransactions.ref })
    .returning({ id: ledgerTransactions.id });
  if (!txn) return false;

  await db.insert(ledgerEntries).values(
    t.entries.map((e) => ({ transactionId: txn.id, merchantId: t.merchantId, account: e.account, amountCents: e.amountCents })),
  );
  return true;
}

export function postCapture(db: DbOrTx, p: { id: string; merchantId: string; amountCents: number }) {
  return postTransaction(db, {
    ref: `capture:${p.id}`,
    merchantId: p.merchantId,
    kind: 'capture',
    paymentId: p.id,
    description: 'Payment captured',
    entries: [
      { account: ACCOUNTS.clearing, amountCents: p.amountCents },
      { account: ACCOUNTS.payable, amountCents: -p.amountCents },
    ],
  });
}

export function postRefund(db: DbOrTx, r: { id: string; paymentId: string; merchantId: string; amountCents: number }) {
  return postTransaction(db, {
    ref: `refund:${r.id}`,
    merchantId: r.merchantId,
    kind: 'refund',
    paymentId: r.paymentId,
    description: 'Refund sent',
    entries: [
      { account: ACCOUNTS.clearing, amountCents: -r.amountCents },
      { account: ACCOUNTS.payable, amountCents: r.amountCents },
    ],
  });
}

/** Balances are always summed from entries, never stored. */
export async function getBalance(db: DbOrTx, merchantId: string) {
  const rows = await db
    .select({ account: ledgerEntries.account, total: sql<string>`coalesce(sum(${ledgerEntries.amountCents}), 0)` })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.merchantId, merchantId))
    .groupBy(ledgerEntries.account);
  const byAccount = Object.fromEntries(rows.map((r) => [r.account, Number(r.total)]));

  const [pending] = await db
    .select({ total: sql<string>`coalesce(sum(${refunds.amountCents}), 0)` })
    .from(refunds)
    .where(and(eq(refunds.merchantId, merchantId), eq(refunds.status, 'pending')));

  return {
    // payable is a credit balance, so flip the sign to show what the merchant is owed
    availableCents: -(byAccount[ACCOUNTS.payable] ?? 0),
    clearingCents: byAccount[ACCOUNTS.clearing] ?? 0,
    pendingRefundsCents: Number(pending?.total ?? 0),
  };
}

export async function listLedger(db: DbOrTx, merchantId: string, limit = 50) {
  const txns = await db
    .select()
    .from(ledgerTransactions)
    .where(eq(ledgerTransactions.merchantId, merchantId))
    .orderBy(desc(ledgerTransactions.createdAt))
    .limit(limit);
  if (txns.length === 0) return [];
  const entries = await db
    .select()
    .from(ledgerEntries)
    .where(inArray(ledgerEntries.transactionId, txns.map((t) => t.id)));
  return txns.map((t) => ({
    id: t.id,
    kind: t.kind,
    ref: t.ref,
    paymentId: t.paymentId,
    description: t.description,
    createdAt: t.createdAt,
    entries: entries
      .filter((e) => e.transactionId === t.id)
      .map((e) => ({ account: e.account, amountCents: e.amountCents })),
  }));
}

/**
 * The invariants the whole system rests on:
 *  1. every ledger transaction sums to zero
 *  2. each merchant's payable balance equals captured payments minus
 *     succeeded refunds, computed independently from the payments tables
 */
export async function checkLedger(db: DbOrTx) {
  const unbalanced = await db
    .select({ transactionId: ledgerEntries.transactionId, sum: sql<string>`sum(${ledgerEntries.amountCents})` })
    .from(ledgerEntries)
    .groupBy(ledgerEntries.transactionId)
    .having(sql`sum(${ledgerEntries.amountCents}) <> 0`);

  const fromLedger = await db
    .select({ merchantId: ledgerEntries.merchantId, owed: sql<string>`-sum(${ledgerEntries.amountCents})` })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.account, ACCOUNTS.payable))
    .groupBy(ledgerEntries.merchantId);

  const captured = await db
    .select({ merchantId: payments.merchantId, total: sql<string>`sum(${payments.amountCents})` })
    .from(payments)
    .where(inArray(payments.status, ['succeeded', 'partially_refunded', 'refunded']))
    .groupBy(payments.merchantId);

  const refunded = await db
    .select({ merchantId: refunds.merchantId, total: sql<string>`sum(${refunds.amountCents})` })
    .from(refunds)
    .where(eq(refunds.status, 'succeeded'))
    .groupBy(refunds.merchantId);

  const merchantIds = new Set([...fromLedger, ...captured, ...refunded].map((r) => r.merchantId));
  const mismatches = [];
  for (const id of merchantIds) {
    const ledger = Number(fromLedger.find((r) => r.merchantId === id)?.owed ?? 0);
    const expected =
      Number(captured.find((r) => r.merchantId === id)?.total ?? 0) -
      Number(refunded.find((r) => r.merchantId === id)?.total ?? 0);
    if (ledger !== expected) mismatches.push({ merchantId: id, ledgerCents: ledger, expectedCents: expected });
  }

  return {
    ok: unbalanced.length === 0 && mismatches.length === 0,
    unbalancedTransactions: unbalanced.map((u) => ({ transactionId: u.transactionId, sumCents: Number(u.sum) })),
    balanceMismatches: mismatches,
    merchantsChecked: merchantIds.size,
  };
}
