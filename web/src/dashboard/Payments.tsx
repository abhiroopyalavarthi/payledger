import { useNavigate } from 'react-router-dom';
import { api, type Balance, type Payment } from '../lib/api';
import { useAuth } from '../lib/auth';
import { shortDate, usd } from '../lib/format';
import { usePolling } from '../lib/usePolling';
import { StatusBadge } from './StatusBadge';

export function Payments() {
  const { session } = useAuth();
  const token = session!.token;
  const navigate = useNavigate();

  const { data, error } = usePolling(async () => {
    const [payments, balance] = await Promise.all([
      api<{ payments: Payment[] }>('/v1/payments', { token }),
      api<{ balance: Balance }>('/v1/balance', { token }),
    ]);
    return { payments: payments.payments, balance: balance.balance };
  });

  return (
    <>
      <div className="page-head">
        <h1>Payments</h1>
        <span className="muted small">Updates every few seconds</span>
      </div>

      {error && <p className="error">{error}</p>}

      <section className="stats">
        <div className="stat">
          <div className="stat-label">Balance owed to you</div>
          <div className="stat-value">{data ? usd(data.balance.availableCents) : '—'}</div>
          <div className="muted small">Sum of your ledger entries</div>
        </div>
        <div className="stat">
          <div className="stat-label">Refunds in flight</div>
          <div className="stat-value">{data ? usd(data.balance.pendingRefundsCents) : '—'}</div>
          <div className="muted small">Waiting for Stripe to confirm</div>
        </div>
        <div className="stat">
          <div className="stat-label">Payments</div>
          <div className="stat-value">{data ? data.payments.length : '—'}</div>
          <div className="muted small">
            {data ? `${data.payments.filter((p) => p.status === 'succeeded').length} succeeded` : ''}
          </div>
        </div>
      </section>

      <div className="card table-card">
        {data && data.payments.length === 0 ? (
          <div className="empty">
            No payments yet. Make a <a href="/links">pay link</a> and open it to take your first test payment.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Description</th>
                <th className="num">Amount</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data?.payments.map((p) => (
                <tr key={p.id} className="clickable" onClick={() => navigate(`/payments/${p.id}`)}>
                  <td>{shortDate(p.createdAt)}</td>
                  <td>{p.description ?? <span className="muted">No description</span>}</td>
                  <td className="num">{usd(p.amountCents)}</td>
                  <td>
                    <StatusBadge status={p.status} />
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
