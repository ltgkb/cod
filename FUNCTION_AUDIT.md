# COD Function Audit

Date: 2026-08-06

## Audit outcome

The original stage reports described a broad architecture, but the deployed product UI still used static tasks, a static execution timeline, fake file/Diff data, a fake Web terminal success result, and several buttons without behavior. The production control plane also allowed a public pilot account to log in without a shared secret and silently substituted a fixed model response when no provider key was configured.

This remediation closes every internal workflow that can be completed without third-party contracts:

- Pilot login now requires an access code, stores only its SHA-256 hash on the server, persists the signed session locally, supports logout, and restricts browser origins.
- Task navigation now reads PostgreSQL state. Search, create, select, start, retry, complete, fail, remote dispatch, optimistic versions, polling, heartbeat, and offline-device presentation are connected end to end.
- Task status transitions are enforced by both memory and PostgreSQL database implementations.
- Conversations are stored per task on the current client. Sending a message moves the task through running to complete or failed and refreshes wallet/ledger state.
- The account panel exposes balance, immutable ledger entries, and honest model, Wiki, payment, and sync capability state. Model reservations settle atomically, duplicate upstream IDs refund their reservation, and process restart recovers orphaned reservations.
- Command palette, account, new-task, model selection, mobile task drawer, Wiki search, device dispatch, project refresh, file preview, Diff, and terminal controls all have explicit behavior.
- Web no longer claims to read local files or execute terminal commands. Those surfaces explain that COD Desktop is required.
- Desktop file reads resolve real paths to prevent symlink escapes. Embedded terminal parsing supports quoted arguments and blocks destructive Git commands.
- API input now reports invalid JSON and oversized bodies correctly. Cursor/limit inputs, chat messages, device platforms, task versions, status transitions, upstream timeouts, and CORS origins are validated.
- Demo model responses preserve the requested model, use a unique response ID, and are explicitly tagged as demo. Production can instead fail closed when demo mode is disabled.
- PWA runtime caching now stores visited shell assets, removes old caches, excludes API/model responses, and includes an install icon.
- Deployment installs safe runtime configuration, retains secrets in the root-only environment file, and adds CSP and browser permission headers.

## Verified internal workflows

1. Access-code login -> signed session -> account and model catalog.
2. Client registration -> heartbeat -> online/offline presentation.
3. Task creation -> synchronized list/search -> versioned status lifecycle.
4. Prompt submission -> running status -> model/demo response -> wallet settlement -> completed or failed status.
5. Remote dispatch -> target device task -> polling visibility.
6. Account -> ledger refresh -> explicit payment availability.
7. Desktop project selection -> bounded tree/read -> Git Diff -> safe command execution.
8. Health/readiness/version/metrics -> systemd health check -> PostgreSQL backup/recovery baseline.

## External boundaries

The following cannot be truthfully marked live until their owners provide contracts and credentials. COD exposes their state instead of simulating completion:

- Real `ai.kai.com` API key, streaming usage semantics, and model error contract.
- Real `wiki.kai.com` search endpoint, API key, ACL mapping, and response schema.
- Payment callbacks, signing keys, reconciliation, refunds, invoices, and anti-fraud rules.
- Feishu and WeCom platform callback schemas, tenant binding, outbound reply credentials, and approval UX.
- Hong Kong SSO/embed contract, production URL, CSP/frame policy, cookies, and logout behavior.
- Public DNS and trusted TLS for `cod.kai.com`; public-IP HTTP is not a production PWA transport.
- Off-host encrypted backups, external monitoring/log aggregation, and high availability.
- Signed/notarized macOS and Windows packages and a real-model desktop Goose acceptance test.

These are integration dependencies, not hidden TODOs. The internal adapters and failure states remain testable without them.
