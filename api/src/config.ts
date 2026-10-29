import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET should be at least 16 characters'),
  ADMIN_TOKEN: z.string().min(8),
  STRIPE_SECRET_KEY: z.string().startsWith('sk_test_', 'only Stripe test/sandbox keys are allowed'),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith('whsec_'),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  PORT: z.coerce.number().int().default(3000),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Bad environment:\n${problems}`);
  }
  return parsed.data;
}
