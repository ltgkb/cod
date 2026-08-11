# COD payment integration

COD treats money movement and wallet credit as two separate systems. A browser redirect never changes balance. Only a verified provider callback that matches a pending COD payment order can create a ledger credit.

## Recommended first provider

- Hong Kong or another Stripe-supported business: start with Stripe-hosted Checkout in one-time payment mode. Enable Alipay, WeChat Pay, and cards only where the account and settlement currency are eligible.
- Mainland China business: use official WeChat Pay and Alipay merchant accounts, or a licensed payment service provider. Do not use personal collection QR codes.

The provider adapter must translate its signed callback into COD's internal payment event. Provider credentials and webhook secrets belong only in `/etc/cod/control-plane.env`.

## COD flow

1. The authenticated client creates `POST /api/payment-orders` with an `idempotency-key`, amount in integer CNY cents, and channel.
2. The server stores a `pending` order before asking a provider to create Checkout or a QR code.
3. The provider adapter associates the COD order ID with the provider payment object using metadata or the provider merchant-order field.
4. The provider calls `POST /api/webhooks/payments`. The adapter signs the exact raw JSON body as `HMAC-SHA256(secret, timestamp + "." + body)` and supplies `x-cod-timestamp` and `x-cod-signature`.
5. COD verifies the five-minute timestamp window and signature, locks the order, checks amount/currency/channel/provider identifiers, writes one immutable ledger entry, and credits the wallet in the same database transaction.
6. The client polls `GET /api/payment-orders/{id}` and refreshes the ledger when the order becomes `paid`.

Example normalized paid event:

```json
{
  "eventId": "provider-event-id",
  "orderId": "cod-order-uuid",
  "status": "paid",
  "amountCents": 5000,
  "currency": "CNY",
  "channel": "alipay",
  "providerPaymentId": "provider-payment-id"
}
```

## Rules that must stay true

- Amounts are integer minor units; never use floating-point yuan in storage or APIs.
- The authenticated user never supplies provider payment IDs or payment status.
- A success/cancel return URL is display-only.
- Webhook signatures are verified against the untouched raw request body.
- COD order IDs, provider payment IDs, and provider event IDs are idempotent and cannot fund multiple orders.
- Refunds create compensating ledger entries; paid ledger rows are never edited or deleted.
- Daily reconciliation compares COD orders and ledger entries with provider settlement reports.
- Test and live keys, endpoints, webhook secrets, and data are strictly separated.

## Before enabling real money

- Confirm the legal entity, settlement country, bank currency, supported business category, fees, refund rules, invoices, and reserve/hold policy with the provider.
- Implement the provider-specific Checkout/QR adapter, webhook signature verification, refund events, expiration, and reconciliation job.
- Run provider sandbox cases for success, cancellation, delayed success, duplicate and out-of-order callbacks, amount mismatch, refund, timeout, and webhook replay.
- Disable `COD_DEVELOPMENT_TOPUP_ENABLED` in production.
- Add finance/admin views for order lookup, ledger lookup, reconciliation exceptions, and manual review. Manual review must not mutate balances directly.

Official starting points:

- Stripe Checkout Sessions: https://docs.stripe.com/payments/checkout-sessions
- Stripe webhooks: https://docs.stripe.com/webhooks
- Stripe payment-method support: https://docs.stripe.com/payments/payment-methods/payment-method-support

