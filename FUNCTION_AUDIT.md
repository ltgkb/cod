# COD Function Audit

Date: 2026-08-06

## Audit outcome

The original stage reports described a broad architecture, but the deployed product UI still used static tasks, a static execution timeline, fake file/Diff data, a fake Web terminal success result, and several buttons without behavior. The production control plane also allowed a public pilot account to log in without a shared secret and silently substituted a fixed model response when no provider key was configured.

This remediation closes every internal workflow that can be completed without third-party contracts:

- Pilot login now requires an access code, stores only its SHA-256 hash on the server, persists the signed session locally, supports logout, and restricts browser origins.
- Task navigation now reads PostgreSQL state. Search, create, select, start, retry, complete, fail, remote dispatch, optimistic versions, polling, heartbeat, and offline-device presentation are connected end to end.
- Task status transitions are enforced by both memory and PostgreSQL database implementations.
- Conversations are stored per task on the current client. The final result/error is also persisted in the synchronized task, so another Web/mobile session and `/status` bot command can read the outcome.
- The account panel exposes balance, immutable ledger entries, source-specific payment direction, and honest model, Wiki, payment, and sync capability state. Model reservations settle atomically, duplicate upstream IDs refund their reservation, and process restart recovers orphaned reservations.
- Command palette, account, new-task, model selection, mobile task drawer, Wiki search, device dispatch, project refresh, file preview, Diff, and terminal controls all have explicit behavior.
- Web no longer claims to read local files or execute terminal commands. Those surfaces explain that COD Desktop is required.
- Desktop file reads resolve real paths to prevent symlink escapes. Embedded terminal parsing supports quoted arguments and blocks destructive Git commands.
- API input now reports invalid JSON and oversized bodies correctly. Cursor/limit inputs, chat messages, device platforms, task versions, status transitions, upstream timeouts, and CORS origins are validated.
- Model selection is driven by live source catalogs and public price metadata. Switching source also switches the model list, upstream route, wallet price, and ledger payment direction; catalog-only sources fail closed.
- Desktop Goose is configured per signed COD user session and selected source/model. Its OpenAI-compatible traffic returns through `/v1/sources/{source}/chat/completions`, so it cannot bypass COD wallet settlement or silently use a company key embedded in the app.
- Live Wiki requests carry tenant/user identity, accept common result envelopes, and reject malformed or unsafe citations.
- The payment callback validates a five-minute HMAC replay window, paid state, CNY currency, allowed account domain, supported channel, and provider-payment idempotency before crediting the wallet.
- Feishu URL verification, signature validation, AES-256-CBC decryption, identity binding, duplicate suppression, task commands, status/result lookup, and OpenAPI replies are implemented behind explicit credentials.
- Hong Kong can receive a five-minute HMAC-signed COD identity assertion without exposing the SSO secret to the client.
- Demo model responses preserve the requested model, use a unique response ID, and are explicitly tagged as demo. Production can instead fail closed when demo mode is disabled.
- PWA runtime caching now stores visited shell assets, removes old caches, excludes API/model responses, and includes an install icon.
- Deployment installs safe runtime configuration, retains secrets in the root-only environment file, and adds CSP and browser permission headers.

## Verified internal workflows

1. Access-code login -> signed session -> account and model catalog.
2. Client registration -> heartbeat -> online/offline presentation.
3. Task creation -> synchronized list/search -> versioned status lifecycle.
4. Source/model selection -> wallet reservation -> live model response -> source-directed settlement -> completed or failed task status.
5. Remote dispatch -> target device task -> polling visibility -> persisted result/error -> Web/mobile and bot status visibility.
6. Account -> ledger refresh -> explicit payment availability.
7. Desktop project selection -> bounded tree/read -> Git Diff -> safe command execution.
8. Health/readiness/version/metrics -> systemd health check -> PostgreSQL backup/recovery baseline.

## External boundaries

The following cannot be truthfully marked live until their owners provide contracts and credentials. COD exposes their state instead of simulating completion:

- Streaming usage semantics and the final production model error contract.
- `chase.kai.com` execution credentials and the remaining provider-source list; Chase is currently catalog-only by design.
- Real `wiki.kai.com` search endpoint, API key, upstream ACL acceptance, and live retrieval benchmark. The client/adapter side is implemented and fails closed without credentials.
- Provider checkout creation, provider-specific signature translation, reconciliation, refunds, invoices, settlement, and anti-fraud rules. The generic verified credit callback is implemented; the visible preload button remains clearly labelled pilot test credit.
- Feishu app credentials, real tenant/open-id bindings, production event registration, and live round-trip acceptance. The official Feishu Webhook/OpenAPI adapter is implemented. WeCom still needs its application-specific callback and outbound API contract.
- Hong Kong acceptance of the signed SSO assertion plus its final embed CSP/frame, cookie, and logout contract. COD's signed launch side is implemented.
- Public DNS and trusted TLS for `cod.kai.com`; public-IP HTTP is not a production PWA transport.
- Off-host encrypted backups, external monitoring/log aggregation, and high availability.
- Signed/notarized macOS and Windows packages and a packaged real-model desktop Goose acceptance test on all three operating systems.

These are integration dependencies, not hidden TODOs. The internal adapters and failure states remain testable without them.
