import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { checkLedger } from '../ledger/ledger.js';
import { AppError } from '../lib/errors.js';

export async function adminRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/v1/admin/ledger-check', async (req) => {
    const given = Buffer.from(String(req.headers['x-admin-token'] ?? ''));
    const expected = Buffer.from(ctx.config.ADMIN_TOKEN);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new AppError(401, 'unauthorized', 'Admin token required');
    }
    return checkLedger(ctx.db);
  });
}
