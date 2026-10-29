import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { merchants, payLinks, payments } from '../db/schema.js';
import { AppError, notFound } from '../lib/errors.js';
import { readIdempotencyKey, withIdempotency } from '../lib/idempotency.js';
import { amountCents, currency } from '../lib/money.js';
import { randomToken } from '../lib/tokens.js';
import { parse } from '../lib/validate.js';
import { createPayment } from '../services/payments.js';

const createLinkBody = z.object({
  amountCents,
  currency,
  description: z.string().trim().min(1).max(200),
});

const serializeLink = (l: typeof payLinks.$inferSelect) => ({
  id: l.id,
  token: l.token,
  amountCents: l.amountCents,
  currency: l.currency,
  description: l.description,
  createdAt: l.createdAt,
});

const tokenParams = z.object({ token: z.string().min(10).max(100) });

export async function payLinkRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: app.authenticate };

  app.post('/v1/pay-links', auth, async (req, reply) => {
    const key = readIdempotencyKey(req);
    const result = await withIdempotency(
      ctx.db,
      { merchantId: req.merchantId, key, method: 'POST', path: '/v1/pay-links', body: req.body },
      async (tx) => {
        const body = parse(createLinkBody, req.body);
        const [link] = await tx
          .insert(payLinks)
          .values({ merchantId: req.merchantId, token: randomToken(), ...body })
          .returning();
        return { status: 201, body: { payLink: serializeLink(link!) } };
      },
    );
    return reply.code(result.status).header('idempotent-replayed', String(result.replayed)).send(result.body);
  });

  app.get('/v1/pay-links', auth, async (req) => {
    const rows = await ctx.db
      .select()
      .from(payLinks)
      .where(eq(payLinks.merchantId, req.merchantId))
      .orderBy(desc(payLinks.createdAt));
    return { payLinks: rows.map(serializeLink) };
  });

  // ---- Public, no login: what the customer pay page calls ----

  async function findLink(token: string) {
    const [row] = await ctx.db
      .select({ link: payLinks, merchantName: merchants.name })
      .from(payLinks)
      .innerJoin(merchants, eq(merchants.id, payLinks.merchantId))
      .where(eq(payLinks.token, token));
    if (!row) throw notFound('Pay link');
    return row;
  }

  app.get('/v1/public/pay-links/:token', async (req) => {
    const { token } = parse(tokenParams, req.params);
    const { link, merchantName } = await findLink(token);
    return {
      merchantName,
      amountCents: link.amountCents,
      currency: link.currency,
      description: link.description,
    };
  });

  // The pay page sends one Idempotency-Key per checkout attempt, so a
  // double-click or a refresh reuses the same payment instead of making a new one.
  app.post('/v1/public/pay-links/:token/checkout', async (req, reply) => {
    const { token } = parse(tokenParams, req.params);
    const key = readIdempotencyKey(req);
    const { link } = await findLink(token);
    const result = await withIdempotency(
      ctx.db,
      { merchantId: link.merchantId, key, method: 'POST', path: `/v1/public/pay-links/${token}/checkout`, body: {} },
      async (tx) => {
        const { payment, clientSecret } = await createPayment(tx, ctx.gateway, {
          merchantId: link.merchantId,
          amountCents: link.amountCents,
          currency: link.currency,
          description: link.description,
          payLinkId: link.id,
          idempotencyKey: `link:${key}`,
        });
        return {
          status: 201,
          body: { paymentToken: payment.publicToken, clientSecret, amountCents: payment.amountCents },
        };
      },
    );
    return reply.code(result.status).header('idempotent-replayed', String(result.replayed)).send(result.body);
  });

  // Polled by the pay page after the card is confirmed. The answer comes
  // from our database, which only changes when Stripe's webhook arrives.
  app.get('/v1/public/payments/:token', async (req) => {
    const { token } = parse(tokenParams, req.params);
    const [row] = await ctx.db
      .select({ status: payments.status, amountCents: payments.amountCents, currency: payments.currency })
      .from(payments)
      .where(eq(payments.publicToken, token));
    if (!row) throw new AppError(404, 'not_found', 'Payment not found');
    return row;
  });
}
