# COD Stage 8 Review

## Delivered

- PostgreSQL-backed accounts, immutable ledger entries, usage reservations, devices, tasks, cursor events, and audit logs.
- User and tenant ownership is enforced in every database query.
- Pilot login is restricted to an explicit KAI email address and allowed domain instead of accepting arbitrary email input.
- Direct development top-ups are disabled in production; verified payment callbacks remain the required production path.
- Model calls reserve the maximum expected charge before contacting the upstream, settle against actual token usage, and release the reservation on upstream failure.
- Non-stream chat usage is automatically priced and recorded exactly once.
- Streaming gateway calls are rejected until a reliable streaming settlement protocol is implemented.
- Bot webhooks require a fresh timestamp, HMAC signature, and explicit bound COD identity.
- Structured HTTP errors now distinguish authentication, authorization, validation, conflict, balance, and internal failures.

## Verification

- Typecheck, lint, production builds, dependency audit, and 12 control-plane/Web tests passed.
- PostgreSQL 16 was installed and the complete schema initialized on the COD server.
- `/ready` reports `database: postgres`.
- A real login, device registration, task creation, chat request, automatic charge, and audit write completed successfully.
- The control-plane service was restarted; the device, task, ledger, balance, and audit data remained available.
- Non-allowlisted login returned 403.
- Direct mock top-up returned 403.
- Unsettled streaming mode returned 400.
- COD and Goose source worktrees remained clean after deployment.

## Review adjustments

- Removed the legacy `AccountStore` and `SyncStore` production-independent implementations. Tests now exercise the same database contract used by PostgreSQL.
- Added transaction-scoped advisory locks so concurrent duplicate idempotency keys cannot race into unique-constraint failures.
- Kept database credentials in the root-only secret environment file; versioned runtime configuration contains no database password.

## Production boundary

- The current email login is a restricted pilot bootstrap, not the final KAI SSO or OTP flow.
- Payment remains disabled until a provider callback contract, signing keys, reconciliation, refunds, and chargeback handling are supplied.
- Streaming responses remain intentionally unavailable through the billed control-plane endpoint.
- Real KAI model credentials and error/usage semantics still require the `ai.kai.com` production contract.
