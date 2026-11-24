# M-Pesa STK Push with reconciliation (TypeScript)

Taking an M-Pesa payment is the easy part. Keeping the books right afterwards is
where most integrations go wrong: Safaricom retries callbacks, customers pay the
wrong amount or pay twice, and some callbacks never arrive.

This repository is a small, dependency-free reference for doing it properly with the
[Daraja API](https://developer.safaricom.co.ke):

- **STK Push client** (`src/daraja.ts`): OAuth token caching, the STK password,
  Kenyan-time timestamps, phone normalisation, whole-shilling amounts.
- **Callback parsing** (`src/callback.ts`): turns Daraja's loose `{Name, Value}`
  metadata into one typed result, and rejects anything malformed.
- **Ledger rules** (`src/ledger.ts`):
  - one payment per M-Pesa receipt, so retried callbacks never double-credit;
  - payments matched by `CheckoutRequestID`, never by amount or phone;
  - a late "failed" callback can never undo a payment;
  - wrong amounts, double payments and unknown payments are **kept and flagged**,
    never dropped.
- **Reconciliation report** (`src/reconcile.ts`): totals, amount mismatches,
  double payments (refund candidates), orphan payments and orders whose callback
  never came.
- **HTTP server** (`src/server.ts`): `node:http` only, a token-protected callback
  URL, a body-size limit, and an acknowledgement only after the result is stored.

## Try it without a Safaricom account

```bash
npm install
npm run reconcile   # replays realistic callbacks, including the messy ones
npm test            # 24 tests
```

`npm run reconcile` prints what happened to each callback and then the report:

```text
{ kind: 'paid', orderId: 'ORD-1001' }
{ kind: 'duplicate', receipt: 'SAB1C2D3E4' }
{ kind: 'amount_mismatch', orderId: 'ORD-1002', expected: 800, received: 700 }
{ kind: 'failed', orderId: 'ORD-1003' }
{ kind: 'paid', orderId: 'ORD-1004' }
{ kind: 'double_payment', orderId: 'ORD-1004', receipt: 'SAB1C2D3E7' }
{ kind: 'orphan_payment', receipt: 'SAB1C2D3E8' }
```

## Run against the Daraja sandbox

1. Create a sandbox app at <https://developer.safaricom.co.ke> and copy `.env.example`
   to `.env`. Fill in the consumer key, secret and passkey.
2. Expose your local port over HTTPS (for example with ngrok) and put that URL in
   `DARAJA_CALLBACK_URL`.
3. Start the server and request a payment:

```bash
npm start
curl -X POST http://localhost:3000/pay \
  -H "Content-Type: application/json" \
  -d '{"orderId":"ORD-1","amount":1,"phone":"07XXXXXXXX"}'
curl http://localhost:3000/reconcile
```

## Taking it to production

The in-memory store is deliberate, so the example runs anywhere. In production:

- back `LedgerStore` with Postgres and put a `UNIQUE` constraint on the receipt
  number, so the database enforces "one payment per receipt" even under concurrency;
- run the reconciliation on a schedule and query Daraja's STK status endpoint for
  every stale pending order;
- restrict the callback route to Safaricom's published IP ranges as well as the token;
- keep secrets in the environment or a secret manager, never in the repository.

## Licence

MIT
