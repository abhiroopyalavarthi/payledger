import { useState, type FormEvent } from 'react';
import { api, type PayLink } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dollarsToCents, shortDate, usd } from '../lib/format';
import { usePolling } from '../lib/usePolling';

const linkUrl = (token: string) => `${window.location.origin}/pay/${token}`;

export function PayLinks() {
  const { session } = useAuth();
  const token = session!.token;
  const { data, refresh } = usePolling(() => api<{ payLinks: PayLink[] }>('/v1/pay-links', { token }), 15000);

  const [amount, setAmount] = useState('25.00');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [attemptKey, setAttemptKey] = useState(() => crypto.randomUUID());

  async function create(e: FormEvent) {
    e.preventDefault();
    const cents = dollarsToCents(amount);
    if (cents === null) {
      setError('Enter an amount like 25 or 25.00');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api('/v1/pay-links', {
        method: 'POST',
        token,
        idempotencyKey: attemptKey,
        body: { amountCents: cents, description },
      });
      setDescription('');
      setAttemptKey(crypto.randomUUID());
      await refresh();
    } catch (err) {
      setError((err as Error).message);
      setAttemptKey(crypto.randomUUID());
    } finally {
      setBusy(false);
    }
  }

  async function copy(t: string) {
    try {
      await navigator.clipboard.writeText(linkUrl(t));
      setCopied(t);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      window.prompt('Copy this link:', linkUrl(t));
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>Pay links</h1>
      </div>
      <form className="card link-form" onSubmit={create}>
        <label>
          Amount (USD)
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </label>
        <label className="grow">
          What it's for
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Spring dues" required maxLength={200} />
        </label>
        <button className="primary" disabled={busy}>
          {busy ? 'Creating…' : 'Create link'}
        </button>
        {error && <p className="error full">{error}</p>}
      </form>

      <div className="card table-card">
        {data && data.payLinks.length === 0 ? (
          <div className="empty">No links yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Created</th>
                <th>Description</th>
                <th className="num">Amount</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data?.payLinks.map((l) => (
                <tr key={l.id}>
                  <td>{shortDate(l.createdAt)}</td>
                  <td>{l.description}</td>
                  <td className="num">{usd(l.amountCents)}</td>
                  <td className="actions">
                    <a href={linkUrl(l.token)} target="_blank" rel="noreferrer">
                      Open
                    </a>
                    <button className="secondary" onClick={() => copy(l.token)}>
                      {copied === l.token ? 'Copied' : 'Copy link'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
