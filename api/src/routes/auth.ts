import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { merchants } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { hashPassword, verifyPassword } from '../lib/passwords.js';
import { parse } from '../lib/validate.js';

const signupBody = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.email().max(200).transform((e) => e.toLowerCase()),
  password: z.string().min(8).max(200),
});

const loginBody = z.object({
  email: z.string().transform((e) => e.toLowerCase()),
  password: z.string(),
});

const publicMerchant = (m: typeof merchants.$inferSelect) => ({
  id: m.id,
  name: m.name,
  email: m.email,
  createdAt: m.createdAt,
});

export async function authRoutes(app: FastifyInstance, ctx: AppContext) {
  const tokenFor = (merchantId: string) => app.jwt.sign({ sub: merchantId }, { expiresIn: '7d' });

  app.post('/v1/merchants', async (req, reply) => {
    const body = parse(signupBody, req.body);
    const passwordHash = await hashPassword(body.password);
    const [merchant] = await ctx.db
      .insert(merchants)
      .values({ name: body.name, email: body.email, passwordHash })
      .onConflictDoNothing({ target: merchants.email })
      .returning();
    if (!merchant) throw new AppError(409, 'email_taken', 'An account with this email already exists');
    return reply.code(201).send({ merchant: publicMerchant(merchant), token: tokenFor(merchant.id) });
  });

  app.post('/v1/auth/login', async (req) => {
    const body = parse(loginBody, req.body);
    const [merchant] = await ctx.db.select().from(merchants).where(eq(merchants.email, body.email));
    // Same error either way, so the endpoint doesn't reveal which emails exist.
    if (!merchant || !(await verifyPassword(body.password, merchant.passwordHash))) {
      throw new AppError(401, 'invalid_credentials', 'Email or password is wrong');
    }
    return { merchant: publicMerchant(merchant), token: tokenFor(merchant.id) };
  });

  app.get('/v1/me', { preHandler: app.authenticate }, async (req) => {
    const [merchant] = await ctx.db.select().from(merchants).where(eq(merchants.id, req.merchantId));
    if (!merchant) throw new AppError(401, 'unauthorized', 'Merchant no longer exists');
    return { merchant: publicMerchant(merchant) };
  });
}
