import { and, asc, eq, sql } from 'drizzle-orm';
import type Stripe from 'stripe';
import type { Tx } from '../db/client.js';
import { payments, refunds, webhookEvents } from '../db/schema.js';
import { postCapture, postRefund } from '../ledger/ledger.js';
import { canTransition, isCaptured, type PaymentStatus } from '../lib/paymentState.js';
import type { Payment } from './payments.js';

export type WebhookOutcome =
  | 'duplicate'
  | 'ignored_event_type'
  | 'unknown_payment'
  | 'unknown_refund'
  | 'stale'
  | 'applied';

const idOf = (v: string | { id: string } | null | undefined) => (typeof v === 'string' ? v : v?.id);

async function lockPaymentByIntent(tx: Tx, intentId: string | undefined) {
  if (!intentId) return undefined;
  const [p] = await tx.select().from(payments).where(eq(payments.stripePaymentIntentId, intentId)).for('update');
  return p;
}

async function moveTo(tx: Tx, payment: Payment, to: PaymentStatus): Promise<boolean> {
  if (payment.status === to || !canTransition(payment.status, to)) return false;
  await tx.update(payments).set({ status: to, updatedAt: new Date() }).where(eq(payments.id, payment.id));
  payment.status = to;
  return true;
}

/** Marks a payment captured and books it in the ledger. Safe to call twice. */
async function capture(tx: Tx, payment: Payment): Promise<boolean> {
  const moved = await moveTo(tx, payment, 'succeeded');
  if (moved) await postCapture(tx, payment);
  return moved;
}

async function succeededRefundCents(tx: Tx, paymentId: string) {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${refunds.amountCents}), 0)` })
    .from(refunds)
    .where(and(eq(refunds.paymentId, paymentId), eq(refunds.status, 'succeeded')));
  return Number(row?.total ?? 0);
}

async function settleRefund(tx: Tx, refund: typeof refunds.$inferSelect) {
  await tx.update(refunds).set({ status: 'succeeded', updatedAt: new Date() }).where(eq(refunds.id, refund.id));
  await postRefund(tx, refund);
}

async function syncRefundStatus(tx: Tx, payment: Payment) {
  const refunded = await succeededRefundCents(tx, payment.id);
  if (refunded >= payment.amountCents) await moveTo(tx, payment, 'refunded');
  else if (refunded > 0) await moveTo(tx, payment, 'partially_refunded');
}

async function onPaymentIntent(tx: Tx, pi: Stripe.PaymentIntent, to: PaymentStatus): Promise<WebhookOutcome> {
  const payment = await lockPaymentByIntent(tx, pi.id);
  if (!payment) return 'unknown_payment';
  if (to === 'succeeded') return (await capture(tx, payment)) ? 'applied' : 'stale';
  return (await moveTo(tx, payment, to)) ? 'applied' : 'stale';
}

/**
 * charge.refunded carries amount_refunded, the running total Stripe has
 * refunded on this charge. Comparing it with what the ledger already has
 * makes the handler order-independent: an older event with a smaller total
 * has nothing new to add.
 */
async function onChargeRefunded(tx: Tx, charge: Stripe.Charge): Promise<WebhookOutcome> {
  const payment = await lockPaymentByIntent(tx, idOf(charge.payment_intent));
  if (!payment) return 'unknown_payment';

  // A refund implies the charge succeeded, even if that webhook hasn't arrived yet.
  if (!isCaptured(payment.status)) await capture(tx, payment);

  let delta = charge.amount_refunded - (await succeededRefundCents(tx, payment.id));
  if (delta <= 0) return 'stale';

  const pending = await tx
    .select()
    .from(refunds)
    .where(and(eq(refunds.paymentId, payment.id), eq(refunds.status, 'pending')))
    .orderBy(asc(refunds.createdAt));
  for (const r of pending) {
    if (r.amountCents <= delta) {
      await settleRefund(tx, r);
      delta -= r.amountCents;
    }
  }
  if (delta > 0) {
    // Refunded from the Stripe dashboard, not through our API. Record it so
    // the ledger still matches Stripe.
    const [external] = await tx
      .insert(refunds)
      .values({
        paymentId: payment.id,
        merchantId: payment.merchantId,
        amountCents: delta,
        status: 'succeeded',
        reason: 'created_outside_payledger',
      })
      .returning();
    await postRefund(tx, external!);
  }

  await syncRefundStatus(tx, payment);
  return 'applied';
}

/** refund.* / charge.refund.updated: settle or fail one specific refund. */
async function onRefundObject(tx: Tx, stripeRefund: Stripe.Refund): Promise<WebhookOutcome> {
  const [refund] = await tx.select().from(refunds).where(eq(refunds.stripeRefundId, stripeRefund.id)).for('update');
  if (!refund) return 'unknown_refund';
  if (refund.status !== 'pending') return 'stale';

  if (stripeRefund.status === 'succeeded') {
    const payment = await lockPaymentByIntent(tx, idOf(stripeRefund.payment_intent));
    if (!payment) return 'unknown_payment';
    if (!isCaptured(payment.status)) await capture(tx, payment);
    await settleRefund(tx, refund);
    await syncRefundStatus(tx, payment);
    return 'applied';
  }
  if (stripeRefund.status === 'failed' || stripeRefund.status === 'canceled') {
    await tx.update(refunds).set({ status: 'failed', updatedAt: new Date() }).where(eq(refunds.id, refund.id));
    return 'applied';
  }
  return 'stale';
}

export const HANDLED_EVENT_TYPES = [
  'payment_intent.processing',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'charge.refunded',
  'charge.refund.updated',
  'refund.created',
  'refund.updated',
  'refund.failed',
] as const;

/**
 * Handles one verified Stripe event inside a single database transaction.
 * The event id goes into webhook_events first; a repeat delivery conflicts
 * there (waiting for the first delivery to commit if they race) and stops.
 */
export async function handleStripeEvent(tx: Tx, event: Stripe.Event): Promise<WebhookOutcome> {
  const fresh = await tx
    .insert(webhookEvents)
    .values({ id: event.id, type: event.type })
    .onConflictDoNothing()
    .returning({ id: webhookEvents.id });
  if (fresh.length === 0) return 'duplicate';

  switch (event.type) {
    case 'payment_intent.processing':
      return onPaymentIntent(tx, event.data.object, 'processing');
    case 'payment_intent.succeeded':
      return onPaymentIntent(tx, event.data.object, 'succeeded');
    case 'payment_intent.payment_failed':
      return onPaymentIntent(tx, event.data.object, 'failed');
    case 'charge.refunded':
      return onChargeRefunded(tx, event.data.object);
    case 'charge.refund.updated':
    case 'refund.created':
    case 'refund.updated':
    case 'refund.failed':
      return onRefundObject(tx, event.data.object);
    default:
      return 'ignored_event_type';
  }
}
