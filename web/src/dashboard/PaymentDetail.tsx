import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type LedgerTxn, type Payment, type Refund } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dollarsToCents, shortDate, usd } from '../lib/format';
import { usePolling } from '../lib/usePolling';
import { StatusBadge } from './StatusBadge';

interface Detail {
  payment: Payment;
  refunds: Refund[];
  ledger: LedgerTxn[];
}

export function PaymentDetail() {
  const { id } = useParams<{ id: string }>();
  const { session } = useAuth();
  const token = session!.token;
  const { data, error, refresh } = usePolling(() => api<Detail>(`/v1/payments/${id}`, { token }), 3000);

  const [amount, setAmount] = useState('');
  const [refundError, setRefundError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One key per refund attempt: a double-click or a retry after a timeout
  // reuses it, so the server refunds once.
  const [attemptKey, setAttemptKey] = useState(() => crypto.randomUUID());

  if (error && !data) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const { payment, refunds, ledger } = data;
  const committed = refunds.filter((r) => r.status !== 'failed').reduce((s, r) => s + r.amountCents, 0);
  const remaining = payment.amountCents - committed;
  const refundable = ['succeeded', 'partially_refunded'].includes(payment.status) && remaining > 0;

  async function submitRefund(e: FormEvent) {
    e.preventDefault();
    const cents = amount.trim() === '' ? remaining : dollarsToCents(amount);
    if (cents === null) {
      setRefundError('Enter an amount like 10 or 10.50');
      return;
    }
    setBusy(true);
    setRefundError(null);
    try {
      await api(`/v1/payments/${payment.id}/refunds`, {
        method: 'POST',
        token,
        idempotencyKey: attemptKey,
        body: { amountCents: cents },
      });
      setAmount('');
      setAttemptKey(crypto.randomUUID());
      await refresh();
    } catch (err) {
      setRefundError((err as Error).message);
      setAttemptKey(crypto.randomUUID());
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="crumbs">
        <Link to="/">← Payments</Link>
      </p>
      <div className="page-head">
        <h1>{usd(payment.amountCents)}</h1>
        <StatusBadge status={payment.status} />
      </div>
      <p className="muted">
        {payment.description ?? 'No description'} · {shortDate(payment.createdAt)}
      </p>

      <div className="grid-2">
        <section className="card">
          <h2>Details</h2>
          <dl className="kv">
            <dt>Payment ID</dt>
            <dd className="mono">{payment.id}</dd>
            <dt>Stripe PaymentIntent</dt>
            <dd className="mono">{payment.stripePaymentIntentId ?? '—'}</dd>
            <dt>Refunded</dt>
            <dd>{usd(refunds.filter((r) => r.status === 'succeeded').reduce((s, r) => s + r.amountCents, 0))}</dd>
            <dt>Left to refund</dt>
            <dd>{usd(Math.max(remaining, 0))}</dd>
          </dl>
        </section>

        <section className="card">
          <h2>Refund</h2>
          {refundable ? (
            <form className="inline-form" onSubmit={submitRefund}>
              <label>
                Amount (blank = refund {usd(remaining)})
                <input
                  inputMode="decimal"
                  placeholder={(remaining / 100).toFixed(2)}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </label>
              <button className="primary" disabled={busy}>
                {busy ? 'Sending…' : 'Issue refund'}
              </button>
              {refundError && <p className="error">{refundError}</p>}
            </form>
          ) : (
            <p className="muted">
              {payment.status === 'refunded' || remaining <= 0
                ? 'Fully refunded.'
                : 'Refunds open once the payment has succeeded.'}
            </p>
          )}
          {refunds.length > 0 && (
            <ul className="refund-list">
              {refunds.map((r) => (
                <li key={r.id}>
                  <span>{usd(r.amountCents)}</span>
                  <span className={`badge badge-${r.status === 'succeeded' ? 'refunded' : r.status}`}>{r.status}</span>
                  <span className="muted small">{shortDate(r.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="card">
        <h2>Ledger entries</h2>
        <p className="muted small">Every money movement is two entries that cancel out. Entries are never edited.</p>
        {ledger.length === 0 ? (
          <p className="muted">Nothing booked yet. Entries are written when Stripe's webhook confirms the payment.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Type</th>
                <th>Account</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {ledger.flatMap((t) =>
                t.entries.map((e, i) => (
                  <tr key={`${t.id}-${i}`} className={i === 0 ? 'txn-start' : ''}>
                    <td>{i === 0 ? shortDate(t.createdAt) : ''}</td>
                    <td>{i === 0 ? t.kind : ''}</td>
                    <td className="mono">{e.account}</td>
                    <td className={`num ${e.amountCents < 0 ? 'neg' : ''}`}>
                      {e.amountCents > 0 ? '+' : '−'}
                      {usd(Math.abs(e.amountCents))}
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
