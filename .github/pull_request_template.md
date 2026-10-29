## What changed

## How I tested it

- [ ] `npm test` passes locally
- [ ] Tried it by hand (say how):

## Review checklist

- [ ] Money is integer cents everywhere (no floats, no `parseFloat`)
- [ ] Every new POST is wrapped in `withIdempotency`
- [ ] Webhook changes stay inside the single DB transaction and keep the event-id dedupe
- [ ] Status changes go through `canTransition`, so nothing moves backward
- [ ] Ledger is only appended to, and every transaction sums to zero
- [ ] Errors use the `{ error: { code, message } }` shape
- [ ] No secrets or `.env` files committed
