import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const paymentStatus = pgEnum('payment_status', [
  'pending',
  'processing',
  'failed',
  'succeeded',
  'partially_refunded',
  'refunded',
]);

export const refundStatus = pgEnum('refund_status', ['pending', 'succeeded', 'failed']);

export const merchants = pgTable('merchants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const payLinks = pgTable(
  'pay_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    merchantId: uuid('merchant_id').notNull().references(() => merchants.id),
    token: text('token').notNull().unique(),
    amountCents: integer('amount_cents').notNull(),
    currency: text('currency').notNull().default('usd'),
    description: text('description').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('pay_links_amount_positive', sql`${t.amountCents} > 0`)],
);

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    merchantId: uuid('merchant_id').notNull().references(() => merchants.id),
    payLinkId: uuid('pay_link_id').references(() => payLinks.id),
    amountCents: integer('amount_cents').notNull(),
    currency: text('currency').notNull().default('usd'),
    description: text('description'),
    status: paymentStatus('status').notNull().default('pending'),
    stripePaymentIntentId: text('stripe_payment_intent_id').unique(),
    // lets the pay page poll its own payment without a merchant login
    publicToken: text('public_token').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('payments_amount_positive', sql`${t.amountCents} > 0`),
    index('payments_merchant_created_idx').on(t.merchantId, t.createdAt),
  ],
);

export const refunds = pgTable(
  'refunds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    paymentId: uuid('payment_id').notNull().references(() => payments.id),
    merchantId: uuid('merchant_id').notNull().references(() => merchants.id),
    amountCents: integer('amount_cents').notNull(),
    status: refundStatus('status').notNull().default('pending'),
    stripeRefundId: text('stripe_refund_id').unique(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('refunds_amount_positive', sql`${t.amountCents} > 0`),
    index('refunds_payment_idx').on(t.paymentId),
  ],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    merchantId: uuid('merchant_id').notNull().references(() => merchants.id),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status').notNull(),
    // text, not jsonb: jsonb reorders keys, and a replay should be byte-identical
    responseBody: text('response_body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.merchantId, t.key] })],
);

export const webhookEvents = pgTable('webhook_events', {
  id: text('id').primaryKey(), // Stripe event id, so a repeat insert conflicts
  type: text('type').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
});

export const ledgerTransactions = pgTable('ledger_transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  // business reference, e.g. "capture:<paymentId>". Unique, so the same
  // money movement can never be posted twice even if a bug slips past the
  // webhook dedupe.
  ref: text('ref').notNull().unique(),
  merchantId: uuid('merchant_id').notNull().references(() => merchants.id),
  kind: text('kind').notNull(),
  paymentId: uuid('payment_id').references(() => payments.id),
  description: text('description').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    transactionId: uuid('transaction_id').notNull().references(() => ledgerTransactions.id),
    merchantId: uuid('merchant_id').notNull().references(() => merchants.id),
    account: text('account').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('ledger_entries_nonzero', sql`${t.amountCents} <> 0`),
    index('ledger_entries_txn_idx').on(t.transactionId),
    index('ledger_entries_merchant_account_idx').on(t.merchantId, t.account),
  ],
);
