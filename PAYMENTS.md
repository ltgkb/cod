# COD payment integration

COD treats money movement and wallet credit as two separate systems. A browser redirect never changes balance. Only a verified provider callback that matches a pending COD payment order can create a ledger credit.

## Official merchant channels

- WeChat Pay uses the official API v3 Native flow. COD signs the Native order request, returns the official `code_url` as an in-browser QR code, verifies the WeChat platform signature, and decrypts the AES-GCM notification resource.
- Alipay uses the official `alipay.trade.page.pay` computer website flow. COD signs the gateway request with RSA2 and verifies the asynchronous notification with the Alipay public key.
- Personal collection QR codes are never accepted.

The provider adapter must translate its signed callback into COD's internal payment event. Provider credentials and webhook secrets belong only in `/etc/cod/control-plane.env`.

## COD flow

1. The authenticated client creates `POST /api/payment-orders` with an `idempotency-key`, amount in integer CNY cents, and channel.
2. The server stores a `pending` order before asking a provider to create Checkout or a QR code.
3. COD sends the order ID as WeChat `out_trade_no` or Alipay `out_trade_no`.
4. WeChat calls `POST /api/webhooks/payments/wechat`; Alipay calls `POST /api/webhooks/payments/alipay`. Each route verifies the provider's official signature format before reading payment status.
5. COD locks the order, checks app/merchant identity, amount, currency, channel and provider identifiers, writes one immutable ledger entry, and credits the wallet in the same database transaction.
6. The client polls `GET /api/payment-orders/{id}` and refreshes the ledger when the order becomes `paid`.

The legacy `POST /api/webhooks/payments` normalized HMAC endpoint remains available only when `COD_PAYMENT_WEBHOOK_SECRET` is explicitly configured for a separately trusted adapter.

Example normalized paid event for that compatibility endpoint:

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
- Configure merchant certificates and keys, then implement refund events, expiration cleanup, and a daily reconciliation job before general availability.
- Run provider sandbox cases for success, cancellation, delayed success, duplicate and out-of-order callbacks, amount mismatch, refund, timeout, and webhook replay.
- Disable `COD_DEVELOPMENT_TOPUP_ENABLED` in production.
- Add finance/admin views for order lookup, ledger lookup, reconciliation exceptions, and manual review. Manual review must not mutate balances directly.

Official references:

- WeChat Pay API v3 Native order: https://pay.wechatpay.cn/doc/v3/merchant/4012791877
- Alipay computer website payment product: https://open.alipay.com/module/webApp
