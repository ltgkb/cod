# COD security and release audit — 2026-08-08

## Scope

The review covers login and sessions, model routing, token settlement, wallet and expiring credit grants, payment callbacks, source commission attribution, KAI Wiki, compute-market leads, Electron IPC and local execution, HTTP/CORS/CSP policy, deployment rollback, dependency audit, and desktop/mobile packaging.

## Closed findings

| Severity | Finding | Resolution |
| --- | --- | --- |
| Critical | A model could return HTTP 200 with empty content, leaving a blank answer | Retry, preferred healthy-model fallback, visible retry state, and no settlement for empty responses |
| High | Reasoning models could spend a small output allowance entirely on reasoning | Provider allowance has a safe 512-token floor while the product limit remains 20,000 tokens |
| High | Nginx could time out before the billed model gateway | `/v1` proxy timeout now covers the gateway retry window |
| High | Fallback could cost more than the amount reserved before the upstream call | Reservation now covers the more expensive of requested and fallback models |
| High | Concurrent callbacks could reuse one provider payment for two COD orders | Transaction advisory locks plus partial unique indexes on event and provider-payment identifiers |
| High | Desktop builds could bundle a Goose binary for the wrong OS | Packaging resolves the sidecar for the runner's OS and architecture |
| High | Electron and Capacitor builds used root-relative assets and could open blank | Vite now emits relative application assets |
| High | Direct IP access sent login/session data over plaintext HTTP | Non-health traffic on the IP is redirected to `https://cod.kai.com` |
| Medium | Electron accepted arbitrary HTTPS external URLs and navigation | Navigation is blocked, only KAI HTTPS links open externally, webviews and runtime permissions are denied |
| Medium | Upstream model and catalog responses were not size bounded | Model replies are streamed into a 5 MiB cap; catalogs are capped at 2 MiB |
| Medium | Packaged app did not define an application CSP | Shared CSP now protects web, Electron, and mobile shells |
| Medium | Mobile shell could not pass origin validation | Native origins are explicit CORS allowlist entries; Android cleartext and backups are disabled |

## Verified controls

- Session signatures use HMAC-SHA256, constant-time comparison, and a seven-day expiry.
- Production refuses weak session secrets, a missing PostgreSQL database, and pilot login without a stored access-code hash.
- Model keys stay server-side; public model catalogs do not contain secret configuration.
- All display sources route to `ai.kai.com`, while the selected display source, actual upstream, model, token use, commission rate, and commission amount remain auditable.
- Usage funds are reserved before the provider call, grants are consumed earliest-expiry first, failures release reservations, and settlement is idempotent.
- The ¥10 trial grant expires after 30 days. Purchased packages expire after 180 days. Permanent wallet funds do not expire.
- Payment callbacks require a five-minute timestamp window, HMAC signature, exact order amount/currency/channel match, and idempotent provider identifiers.
- The Wiki adapter is restricted to the configured HTTPS origin, has time and response-size limits, and does not expose its API key.
- Electron uses context isolation, sandboxing, no renderer Node integration, file-root approval, real-path containment, command allowlisting, and no shell interpolation.
- Deployments run type checks, tests, lint, production builds, dependency audit, Nginx validation, readiness checks, atomic release switching, and rollback.
- `npm audit` reports zero known vulnerabilities at the time of this audit.

## Release blockers still requiring business credentials

1. Production payments are still in `pilot-credit` mode. Before taking customer money, configure a real WeChat/Alipay adapter and `COD_PAYMENT_WEBHOOK_SECRET`, then disable `COD_DEVELOPMENT_TOPUP_ENABLED`.
2. Apple, Windows, and Android public releases require organization-owned signing credentials. They are intentionally not stored in the repository.
3. Channel commission is recorded but defaults to zero until an approved `CHASE_COMMISSION_RATE_BPS` is configured.
4. Feishu and WeCom remain unavailable until their application credentials and verified identity bindings are supplied.

These are external credential/configuration gates, not silent fallbacks. The capability API and UI expose the current mode.
