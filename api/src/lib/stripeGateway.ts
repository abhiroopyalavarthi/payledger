import Stripe from 'stripe';

// The only Stripe calls the API makes. Routes depend on this interface, so
// tests can swap in a fake while webhook signature checks still use the real
// Stripe library.
export interface PaymentGateway {
  createPaymentIntent(args: {
    amountCents: number;
    currency: string;
    paymentId: string;
    merchantId: string;
    idempotencyKey: string;
  }): Promise<{ id: string; clientSecret: string }>;

  createRefund(args: {
    paymentIntentId: string;
    amountCents: number;
    refundId: string;
    idempotencyKey: string;
  }): Promise<{ id: string }>;
}

export class StripeGateway implements PaymentGateway {
  constructor(private readonly stripe: Stripe) {}

  async createPaymentIntent(args: Parameters<PaymentGateway['createPaymentIntent']>[0]) {
    const pi = await this.stripe.paymentIntents.create(
      {
        amount: args.amountCents,
        currency: args.currency,
        automatic_payment_methods: { enabled: true },
        metadata: { payment_id: args.paymentId, merchant_id: args.merchantId },
      },
      // Forward our idempotency key: if our DB transaction rolls back after
      // this call and the client retries, Stripe hands back the same intent.
      { idempotencyKey: args.idempotencyKey },
    );
    if (!pi.client_secret) throw new Error('Stripe returned a PaymentIntent without a client secret');
    return { id: pi.id, clientSecret: pi.client_secret };
  }

  async createRefund(args: Parameters<PaymentGateway['createRefund']>[0]) {
    const refund = await this.stripe.refunds.create(
      {
        payment_intent: args.paymentIntentId,
        amount: args.amountCents,
        metadata: { refund_id: args.refundId },
      },
      { idempotencyKey: args.idempotencyKey },
    );
    return { id: refund.id };
  }
}
