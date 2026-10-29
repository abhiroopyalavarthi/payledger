export const usd = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/** "25" -> 2500, "25.5" -> 2550. Parsed as a string so no float math ever touches money. */
export function dollarsToCents(input: string): number | null {
  const m = /^\s*\$?(\d{1,7})(?:\.(\d{1,2}))?\s*$/.exec(input);
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return cents > 0 ? cents : null;
}

export const shortDate = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export const statusLabel: Record<string, string> = {
  pending: 'Pending',
  processing: 'Processing',
  failed: 'Failed',
  succeeded: 'Succeeded',
  partially_refunded: 'Partially refunded',
  refunded: 'Refunded',
};
