export const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3000';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown; token?: string | null; idempotencyKey?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch {
    throw new ApiError(0, 'network_error', "Can't reach the API. If it's the free Render instance, it may take a minute to wake up.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (data as { error?: { code: string; message: string; details?: unknown } }).error;
    throw new ApiError(res.status, err?.code ?? 'unknown', err?.message ?? `Request failed (${res.status})`, err?.details);
  }
  return data as T;
}

// Shapes returned by the API
export type PaymentStatus = 'pending' | 'processing' | 'failed' | 'succeeded' | 'partially_refunded' | 'refunded';

export interface Payment {
  id: string;
  amountCents: number;
  currency: string;
  description: string | null;
  status: PaymentStatus;
  payLinkId: string | null;
  stripePaymentIntentId: string | null;
  createdAt: string;
}

export interface Refund {
  id: string;
  amountCents: number;
  status: 'pending' | 'succeeded' | 'failed';
  reason: string | null;
  createdAt: string;
}

export interface LedgerTxn {
  id: string;
  kind: string;
  description: string;
  createdAt: string;
  entries: { account: string; amountCents: number }[];
}

export interface Balance {
  availableCents: number;
  clearingCents: number;
  pendingRefundsCents: number;
}

export interface PayLink {
  id: string;
  token: string;
  amountCents: number;
  description: string;
  createdAt: string;
}
