import { statusLabel } from '../lib/format';

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge-${status}`}>{statusLabel[status] ?? status}</span>;
}
