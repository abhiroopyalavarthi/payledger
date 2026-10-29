import { z } from 'zod';

// Money is always an integer number of cents. Stripe's max charge is $999,999.99.
export const amountCents = z.number().int('amount must be whole cents').positive().max(99_999_999);
export const currency = z.literal('usd').default('usd');

export const formatUsd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
