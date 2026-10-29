export type PaymentStatus =
  | 'pending'
  | 'processing'
  | 'failed'
  | 'succeeded'
  | 'partially_refunded'
  | 'refunded';

// Allowed moves. Anything not listed is ignored, which is what keeps a late,
// out-of-order webhook from dragging a payment backward. "failed" is not a
// dead end: Stripe lets the customer retry the same PaymentIntent with
// another card, so failed -> succeeded is legal.
const transitions: Record<PaymentStatus, readonly PaymentStatus[]> = {
  pending: ['processing', 'succeeded', 'failed'],
  processing: ['succeeded', 'failed'],
  failed: ['processing', 'succeeded'],
  succeeded: ['partially_refunded', 'refunded'],
  partially_refunded: ['refunded'],
  refunded: [],
};

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return transitions[from].includes(to);
}

export const isCaptured = (s: PaymentStatus) =>
  s === 'succeeded' || s === 'partially_refunded' || s === 'refunded';
