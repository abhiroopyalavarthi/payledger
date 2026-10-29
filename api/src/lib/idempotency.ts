import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { Db, Tx } from '../db/client.js';
import { idempotencyKeys } from '../db/schema.js';
import { AppError } from './errors.js';

export interface HandlerResult {
  status: number;
  body: unknown;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function requestHash(method: string, path: string, body: unknown): string {
  return createHash('sha256').update(`${method} ${path}\n${stableStringify(body)}`).digest('hex');
}

export function readIdempotencyKey(req: FastifyRequest): string {
  const raw = req.headers['idempotency-key'];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (!key || key.length > 255) {
    throw new AppError(400, 'idempotency_key_required', 'Send an Idempotency-Key header (1-255 characters) with every POST');
  }
  return key;
}

/**
 * Runs a write at most once per (merchant, key).
 *
 * The key row is inserted at the start of the same database transaction that
 * does the work. A concurrent request with the same key blocks on the primary
 * key until this transaction finishes, then finds the saved response and
 * returns it unchanged. If the work crashes (5xx), everything rolls back,
 * the key included, so the client can safely retry.
 *
 * Business errors (4xx) are saved like successes, the way Stripe does it:
 * retrying a rejected request gets the same rejection back.
 */
export async function withIdempotency(
  db: Db,
  opts: { merchantId: string; key: string; method: string; path: string; body: unknown },
  handler: (tx: Tx) => Promise<HandlerResult>,
): Promise<HandlerResult & { replayed: boolean }> {
  const hash = requestHash(opts.method, opts.path, opts.body);

  return db.transaction(async (tx) => {
    const claimed = await tx
      .insert(idempotencyKeys)
      .values({ merchantId: opts.merchantId, key: opts.key, requestHash: hash, responseStatus: 0, responseBody: '' })
      .onConflictDoNothing()
      .returning({ key: idempotencyKeys.key });

    if (claimed.length === 0) {
      const [saved] = await tx
        .select()
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.merchantId, opts.merchantId), eq(idempotencyKeys.key, opts.key)));
      if (!saved) throw new Error('idempotency key vanished between insert and select');
      if (saved.requestHash !== hash) {
        throw new AppError(422, 'idempotency_key_reused', 'This Idempotency-Key was already used with a different request');
      }
      return { status: saved.responseStatus, body: JSON.parse(saved.responseBody) as unknown, replayed: true };
    }

    let result: HandlerResult;
    try {
      // Savepoint: a business error undoes the handler's writes but keeps the key row.
      result = await tx.transaction((sp) => handler(sp));
    } catch (err) {
      if (err instanceof AppError && err.status < 500) {
        result = { status: err.status, body: err.toBody() };
      } else {
        throw err;
      }
    }

    await tx
      .update(idempotencyKeys)
      .set({ responseStatus: result.status, responseBody: JSON.stringify(result.body) })
      .where(and(eq(idempotencyKeys.merchantId, opts.merchantId), eq(idempotencyKeys.key, opts.key)));

    return { ...result, replayed: false };
  });
}
