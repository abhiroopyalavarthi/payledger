import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { payments } from '../db/schema.js';
import { getBalance, listLedger } from '../ledger/ledger.js';
import { readIdempotencyKey, withIdempotency } from '../lib/idempotency.js';
import { amountCents, currency } from '../lib/money.js';
import { parse } from '../lib/validate.js';
import {
  createPayment,
  createRefund,
  getPaymentForMerchant,
  serializePayment,
  serializeRefund,
} from '../services/payments.js';

const createPaymentBody = z.object({
  amountCents,
  currency,
  description: z.string().trim().max(500).optional(),
});

const refundBody = z.object({
  amountCents: amountCents.optional(), // omitted = refund whatever is left
  reason: z.string().trim().max(200).optional(),
});

const listQuery = z.object({
  status: z.enum(['pending', 'processing', 'failed', 'succeeded', 'partially_refunded', 'refunded']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const idParams = z.object({ id: z.uuid() });

export async function paymentRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: app.authenticate };

  app.post('/v1/payments', auth, async (req, reply) => {
    const key = readIdempotencyKey(req);
    const result = await withIdempotency(
      ctx.db,
      { merchantId: req.merchantId, key, method: 'POST', path: '/v1/payments', body: req.body },
      async (tx) => {
        const body = parse(createPaymentBody, req.body);
        const { payment, clientSecret } = await createPayment(tx, ctx.gateway, {
          merchantId: req.merchantId,
          amountCents: body.amountCents,
          currency: body.currency,
          description: body.description,
          idempotencyKey: key,
        });
        return { status: 201, body: { payment: serializePayment(payment), clientSecret } };
      },
    );
    return reply.code(result.status).header('idempotent-replayed', String(result.replayed)).send(result.body);
  });

  app.get('/v1/payments', auth, async (req) => {
    const q = parse(listQuery, req.query);
    const rows = await ctx.db
      .select()
      .from(payments)
      .where(and(eq(payments.merchantId, req.merchantId), q.status ? eq(payments.status, q.status) : undefined))
      .orderBy(desc(payments.createdAt))
      .limit(q.limit);
    return { payments: rows.map(serializePayment) };
  });

  app.get('/v1/payments/:id', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const { payment, refunds } = await getPaymentForMerchant(ctx.db, req.merchantId, id);
    const ledger = (await listLedger(ctx.db, req.merchantId, 500)).filter((t) => t.paymentId === id);
    return { payment: serializePayment(payment), refunds: refunds.map(serializeRefund), ledger };
  });

  app.post('/v1/payments/:id/refunds', auth, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const key = readIdempotencyKey(req);
    const result = await withIdempotency(
      ctx.db,
      { merchantId: req.merchantId, key, method: 'POST', path: `/v1/payments/${id}/refunds`, body: req.body ?? {} },
      async (tx) => {
        const body = parse(refundBody, req.body ?? {});
        const refund = await createRefund(tx, ctx.gateway, {
          merchantId: req.merchantId,
          paymentId: id,
          amountCents: body.amountCents,
          reason: body.reason,
          idempotencyKey: key,
        });
        return { status: 201, body: { refund: serializeRefund(refund) } };
      },
    );
    return reply.code(result.status).header('idempotent-replayed', String(result.replayed)).send(result.body);
  });

  app.get('/v1/balance', auth, async (req) => ({ balance: await getBalance(ctx.db, req.merchantId) }));

  app.get('/v1/ledger', auth, async (req) => {
    const { limit } = parse(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    return { transactions: await listLedger(ctx.db, req.merchantId, limit) };
  });
}
