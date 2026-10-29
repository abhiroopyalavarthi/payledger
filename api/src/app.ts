import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { AppContext } from './context.js';
import { AppError } from './lib/errors.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { payLinkRoutes } from './routes/payLinks.js';
import { paymentRoutes } from './routes/payments.js';
import { webhookRoutes } from './routes/webhooks.js';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    merchantId: string;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string };
  }
}

export async function buildApp(ctx: AppContext, opts: { logger?: boolean } = {}) {
  const app = Fastify({
    logger: opts.logger
      ? {
          // Log every request with its idempotency key so a retry can be traced.
          serializers: {
            req: (req) => ({
              method: req.method,
              url: req.url,
              idempotencyKey: req.headers['idempotency-key'],
            }),
          },
        }
      : false,
  });

  await app.register(cors, {
    origin: ctx.config.WEB_ORIGIN.split(',').map((o) => o.trim()),
    allowedHeaders: ['content-type', 'authorization', 'idempotency-key'],
    exposedHeaders: ['idempotent-replayed'],
  });
  await app.register(jwt, { secret: ctx.config.JWT_SECRET });

  app.decorateRequest('merchantId', '');
  app.decorate('authenticate', async (req: FastifyRequest) => {
    try {
      const payload = await req.jwtVerify<{ sub: string }>();
      req.merchantId = payload.sub;
    } catch {
      throw new AppError(401, 'unauthorized', 'Log in first (missing or expired token)');
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send(err.toBody());
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: { code: 'bad_request', message: (err as Error).message } });
    }
    req.log.error(err);
    return reply.code(500).send({ error: { code: 'internal_error', message: 'Something went wrong on our side' } });
  });
  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ error: { code: 'not_found', message: 'No such route' } }),
  );

  app.get('/health', async () => ({ ok: true }));

  await app.register(async (scope) => authRoutes(scope, ctx));
  await app.register(async (scope) => paymentRoutes(scope, ctx));
  await app.register(async (scope) => payLinkRoutes(scope, ctx));
  await app.register(async (scope) => adminRoutes(scope, ctx));
  await app.register(async (scope) => webhookRoutes(scope, ctx));

  return app;
}
