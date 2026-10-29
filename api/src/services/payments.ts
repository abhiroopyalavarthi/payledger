import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { DbOrTx, Tx } from '../db/client.js';
import { payments, refunds } from '../db/schema.js';
import { AppError, notFound } from '../lib/errors.js';
import { isCaptured } from '../lib/paymentState.js';
import type { PaymentGateway } from '../lib/stripeGateway.js';
import { randomToken } from '../lib/tokens.js';

export type Payment = typeof payments.$inferSelect;
export type Refund = typeof refunds.$inferSelect;

export const serializePayment = (p: Payment) => ({
  id: p.id,
  amountCents: p.amountCents,
  currency: p.currency,
  description: p.description,
  status: p.status,
  payLinkId: p.payLinkId,
  stripePaymentIntentId: p.stripePaymentIntentId,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

export const serializeRefund = (r: Refund) => ({
  id: r.id,
  paymentId: r.paymentId,
  amountCents: r.amountCents,
  status: r.status,
  reason: r.reason,
  stripeRefundId: r.stripeRefundId,
  createdAt: r.createdAt,
});

/** Saves a pending payment and opens a Stripe PaymentIntent for it. */
export async function createPayment(
  tx: Tx,
  gateway: PaymentGateway,
  input: {
    merchantId: string;
    amountCents: number;
    currency: string;
    description?: string | null;
    payLinkId?: string;
    idempotencyKey: string;
  },
) {
  const id = randomUUID();
  const [created] = await tx
    .insert(payments)
    .values({
      id,
      merchantId: input.merchantId,
      payLinkId: input.payLinkId,
      amountCents: input.amountCents,
      currency: input.currency,
      description: input.description ?? null,
      publicToken: randomToken(),
    })
    .returning();
  if (!created) throw new Error('payment insert returned nothing');

  const intent = await gateway.createPaymentIntent({
    amountCents: input.amountCents,
    currency: input.currency,
    paymentId: id,
    merchantId: input.merchantId,
    idempotencyKey: `payment:${input.merchantId}:${input.idempotencyKey}`,
  });

  const [payment] = await tx
    .update(payments)
    .set({ stripePaymentIntentId: intent.id, updatedAt: new Date() })
    .where(eq(payments.id, id))
    .returning();
  return { payment: payment!, clientSecret: intent.clientSecret };
}

/** Cents already refunded or on their way out (pending + succeeded). */
async function committedRefundCents(tx: DbOrTx, paymentId: string) {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${refunds.amountCents}), 0)` })
    .from(refunds)
    .where(and(eq(refunds.paymentId, paymentId), inArray(refunds.status, ['pending', 'succeeded'])));
  return Number(row?.total ?? 0);
}

/**
 * Starts a refund. The payment row is locked FOR UPDATE, so two refunds
 * racing each other run one after the other and the second one sees the
 * first. The refund stays pending until Stripe's webhook confirms it.
 */
export async function createRefund(
  tx: Tx,
  gateway: PaymentGateway,
  input: { merchantId: string; paymentId: string; amountCents?: number; reason?: string; idempotencyKey: string },
) {
  const [payment] = await tx
    .select()
    .from(payments)
    .where(and(eq(payments.id, input.paymentId), eq(payments.merchantId, input.merchantId)))
    .for('update');
  if (!payment) throw notFound('Payment');
  if (!isCaptured(payment.status) || payment.status === 'refunded' || !payment.stripePaymentIntentId) {
    throw new AppError(409, 'payment_not_refundable', `A ${payment.status} payment can't be refunded`);
  }

  const already = await committedRefundCents(tx, payment.id);
  const remaining = payment.amountCents - already;
  const amount = input.amountCents ?? remaining;
  if (amount <= 0 || amount > remaining) {
    throw new AppError(422, 'refund_exceeds_payment', 'Refund is more than what is left on this payment', {
      requestedCents: amount,
      remainingCents: remaining,
    });
  }

  const id = randomUUID();
  await tx.insert(refunds).values({
    id,
    paymentId: payment.id,
    merchantId: payment.merchantId,
    amountCents: amount,
    reason: input.reason ?? null,
  });

  const stripeRefund = await gateway.createRefund({
    paymentIntentId: payment.stripePaymentIntentId,
    amountCents: amount,
    refundId: id,
    idempotencyKey: `refund:${input.merchantId}:${input.idempotencyKey}`,
  });

  const [refund] = await tx
    .update(refunds)
    .set({ stripeRefundId: stripeRefund.id, updatedAt: new Date() })
    .where(eq(refunds.id, id))
    .returning();
  return refund!;
}

export async function getPaymentForMerchant(db: DbOrTx, merchantId: string, paymentId: string) {
  const [payment] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.id, paymentId), eq(payments.merchantId, merchantId)));
  if (!payment) throw notFound('Payment');
  const paymentRefunds = await db
    .select()
    .from(refunds)
    .where(eq(refunds.paymentId, paymentId))
    .orderBy(asc(refunds.createdAt));
  return { payment, refunds: paymentRefunds };
}
