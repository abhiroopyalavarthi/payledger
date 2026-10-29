import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe } from '@stripe/stripe-js';
import { useEffect, useState, type FormEvent } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { usd } from '../lib/format';

const publishableKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined;
const stripePromise = publishableKey ? loadStripe(publishableKey) : null;

interface LinkInfo {
  merchantName: string;
  amountCents: number;
  currency: string;
  description: string;
}

interface Checkout {
  paymentToken: string;
  clientSecret: string;
}

type Phase = 'form' | 'confirming' | 'waiting' | 'succeeded' | 'failed' | 'slow';

/**
 * One idempotency key per pay link per browser tab. Refreshing the page
 * reuses it, so the customer keeps the same payment instead of opening a
 * new one each time.
 */
function checkoutKey(linkToken: string) {
  const storageKey = `payledger.checkout.${linkToken}`;
  try {
    const existing = sessionStorage.getItem(storageKey);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    sessionStorage.setItem(storageKey, fresh);
    return fresh;
  } catch {
    return crypto.randomUUID();
  }
}

function forgetCheckout(linkToken: string) {
  try {
    sessionStorage.removeItem(`payledger.checkout.${linkToken}`);
  } catch {
    /* ignore */
  }
}

/**
 * Waits for the result from OUR server. The browser being told "succeeded"
 * by Stripe.js is not proof; the payment counts once Stripe's signed webhook
 * has reached the API and been written to the ledger.
 */
async function waitForWebhook(paymentToken: string, onPhase: (p: Phase) => void) {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    try {
      const { status } = await api<{ status: string }>(`/v1/public/payments/${paymentToken}`);
      if (status === 'succeeded' || status === 'partially_refunded' || status === 'refunded') return onPhase('succeeded');
      if (status === 'failed') return onPhase('failed');
    } catch {
      /* keep trying */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  onPhase('slow');
}

function CheckoutForm({ info, checkout, linkToken }: { info: LinkInfo; checkout: Checkout; linkToken: string }) {
  const stripe = useStripe();
  const elements = useElements();
  const [phase, setPhase] = useState<Phase>('form');
  const [message, setMessage] = useState<string | null>(null);

  async function pay(e: FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setPhase('confirming');
    setMessage(null);
    const returnUrl = new URL(window.location.href);
    returnUrl.searchParams.set('pt', checkout.paymentToken);

    const { error } = await stripe.confirmPayment({
      elements,
      redirect: 'if_required', // cards finish here; 3-D Secure may redirect and come back with ?pt=
      confirmParams: { return_url: returnUrl.toString() },
    });
    if (error) {
      // Card declined, bad CVC, etc. The customer can fix it and try again
      // on the same PaymentIntent.
      setMessage(error.message ?? 'Payment failed');
      setPhase('form');
      return;
    }
    setPhase('waiting');
    await waitForWebhook(checkout.paymentToken, (p) => {
      if (p === 'succeeded') forgetCheckout(linkToken);
      setPhase(p);
    });
  }

  if (phase === 'succeeded') return <Result ok title="Payment received" body={`You paid ${usd(info.amountCents)} to ${info.merchantName}.`} />;
  if (phase === 'failed') return <Result title="Payment failed" body="Your card wasn't charged. You can go back and try a different card." />;
  if (phase === 'slow')
    return <Result title="Still confirming" body="Your payment went through to Stripe, but confirmation is taking longer than usual. You don't need to pay again." />;

  return (
    <form onSubmit={pay} className="pay-form">
      <PaymentElement />
      {message && <p className="error">{message}</p>}
      <button className="primary wide" disabled={!stripe || phase !== 'form'}>
        {phase === 'confirming' ? 'Processing…' : phase === 'waiting' ? 'Confirming with the bank…' : `Pay ${usd(info.amountCents)}`}
      </button>
      <p className="muted small center">Test mode: use card 4242 4242 4242 4242, any future date, any CVC.</p>
    </form>
  );
}

function Result({ ok, title, body }: { ok?: boolean; title: string; body: string }) {
  return (
    <div className="result">
      <div className={`result-icon ${ok ? 'ok' : 'bad'}`}>{ok ? '✓' : '!'}</div>
      <h2>{title}</h2>
      <p className="muted">{body}</p>
    </div>
  );
}

export function PayPage() {
  const { token = '' } = useParams<{ token: string }>();
  const [search] = useSearchParams();
  const returningToken = search.get('pt'); // back from a 3-D Secure redirect

  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const [phase, setPhase] = useState<Phase | null>(returningToken ? 'waiting' : null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const link = await api<LinkInfo>(`/v1/public/pay-links/${token}`);
        if (cancelled) return;
        setInfo(link);
        if (returningToken) {
          await waitForWebhook(returningToken, (p) => !cancelled && setPhase(p));
          return;
        }
        const c = await api<Checkout>(`/v1/public/pay-links/${token}/checkout`, {
          method: 'POST',
          idempotencyKey: checkoutKey(token),
          body: {},
        });
        if (!cancelled) setCheckout(c);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, returningToken]);

  return (
    <div className="center-page pay-bg">
      <div className="card pay-card">
        {error ? (
          <Result title="This link isn't working" body={error} />
        ) : !info ? (
          <p className="muted center">Loading…</p>
        ) : (
          <>
            <div className="pay-head">
              <div className="muted small">Pay {info.merchantName}</div>
              <div className="pay-amount">{usd(info.amountCents)}</div>
              <div>{info.description}</div>
            </div>
            {phase === 'waiting' ? (
              <p className="muted center">Confirming your payment…</p>
            ) : phase === 'succeeded' ? (
              <Result ok title="Payment received" body={`You paid ${usd(info.amountCents)} to ${info.merchantName}.`} />
            ) : phase === 'failed' || phase === 'slow' ? (
              <Result title={phase === 'failed' ? 'Payment failed' : 'Still confirming'} body="Refresh this page to check again." />
            ) : !stripePromise ? (
              <p className="error">The site is missing its Stripe publishable key (VITE_STRIPE_PUBLISHABLE_KEY).</p>
            ) : !checkout ? (
              <p className="muted center">Setting up a secure checkout…</p>
            ) : (
              <Elements stripe={stripePromise} options={{ clientSecret: checkout.clientSecret, appearance: { theme: 'stripe' } }}>
                <CheckoutForm info={info} checkout={checkout} linkToken={token} />
              </Elements>
            )}
          </>
        )}
        <p className="powered muted small">Payments by Stripe · PayLedger demo</p>
      </div>
    </div>
  );
}
