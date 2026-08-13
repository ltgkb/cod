# COD

COD is a cross-platform agent workspace for code optimization and everyday AI conversations.

## Open source

COD is open source under the Apache License 2.0. Forks, integrations, bug reports, and pull requests are welcome. See `CONTRIBUTING.md` for contribution guidelines and `SECURITY.md` for responsible vulnerability reporting.

The open-source license covers the code in this repository. Third-party services, model APIs, hosted infrastructure, trademarks, and separately licensed assets remain subject to their own terms.

## Architecture

- `apps/web`: shared React product UI for desktop, web, and the future PWA.
- `apps/desktop`: Electron shell with local project, file, diff, and terminal access.
- `packages/contracts`: shared types for the control plane and integrations.
- `distribution`: COD branding, provider defaults, and packaging metadata.
- Goose runs as the local ACP execution sidecar and remains independently upgradeable.

## Development

```bash
npm install
npm run dev
npm run typecheck
npm test
npm run build
npm run package:linux
npm run package:mac
npm run package:win
```

## Product behavior

- Web and desktop clients use email/password authentication and retain the signed session on the current device. Registration is open when enabled; invite codes are optional and only bind immutable referral attribution. Existing users can copy their code from the account panel.
- Tasks, devices, status transitions, wallet entries, and audit records come from the control plane; the UI does not render static task or terminal-success fixtures.
- The shared Web/mobile/desktop UI can create, search, synchronize, execute, retry, complete, and terminate tasks. Termination aborts task-bound model requests, stops the packaged Desktop Goose sidecar, releases reserved funds, persists the `cancelled` state, and remains visible from other devices. Local files, Git Diff, terminal commands, and Goose execution are available only through the desktop bridge.
- Model sources are discovered from their live catalogs. The selected source controls the model list, upstream route, displayed price, wallet settlement, and ledger payment direction.
- `ai.kai.com` is the only upstream model gateway. Display sources such as `AI.KAI.COM` and `CHASE.KAI.COM` reuse its verified catalog and callable route while keeping source attribution, commission, payment direction, and ledger records separate.
- Goose receives the signed COD user session, task ID, selected source, and selected model through the Electron IPC boundary. It calls the task-bound billed COD gateway rather than holding a company provider key, so desktop Agent usage follows the same cancellation, reservation, settlement, and ledger path as Web chat.
- The pilot wallet supports explicitly labelled test-credit preloads. A production callback adapter accepts only recent HMAC-signed, CNY `paid` events and credits them idempotently; checkout acquisition, refunds, invoices, and provider settlement remain provider-owned dependencies.
- Real payment callbacks must match a previously created COD payment order. Amount, currency, channel, provider payment ID, and provider event ID are checked before the wallet and immutable ledger are updated in one transaction. See `PAYMENTS.md`.
- The Wiki adapter propagates tenant/user identity, normalizes multiple search response envelopes, limits response size, and drops unsafe citation URLs.
- The Feishu adapter supports official URL verification, signature validation, encrypted event decryption, tenant/open-id binding, message deduplication, `/run` and `/status`, and OpenAPI replies. WeCom remains behind the generic signed adapter until its application contract is supplied.
- Hong Kong launches directly by default or with a five-minute signed SSO assertion when `KAI_HONGKONG_SSO_SECRET` is configured.
- The packaged desktop receives its control-plane URL through `COD_CONTROL_PLANE_URL` and defaults to the current pilot server.
- Desktop can discover an independently installed, loopback-only Dashi Taskboard companion as a transitional bridge. Setup and the data/security boundary are documented in `docs/DASHI_COMPANION_BRIDGE.md`; the license-safe native migration remains specified in `docs/DASHI_TASKBOARD_INTEGRATION.md`.
- Desktop can verify and launch COD 桌面伙伴 0.7.0 on macOS, Windows, and Linux. Real chat uses an ephemeral loopback proxy so the companion never receives the COD login token. Installation paths, package hashes, and signing blockers are documented in `docs/DESKTOP_PET_INTEGRATION.md`.
- The current compute exchange covers rental, supply listing, third-party hosting, and equipment installment requests. Admins can review applicant details and issue an expiring quote; only the owning user can accept it before deployment. The V2 product/merge contract is documented in `docs/COMPUTE_MARKET_V2_DESIGN_SPEC.md`, the card-hour settlement and internal-trading rules in `docs/CARD_HOUR_SETTLEMENT_SPEC.md`, and the V1 lifecycle boundary in `docs/COMPUTE_MARKET_LIFECYCLE.md`.

## Production configuration

The control plane requires PostgreSQL and a pilot access-code hash in production when legacy pilot login is enabled. Generate the hash without storing the plaintext code in Git:

```bash
printf %s 'your-access-code' | sha256sum
```

Configure `COD_PILOT_ACCESS_CODE_HASH` in the root-only `/etc/cod/control-plane.env`. Safe, versioned runtime flags live in `deploy/runtime.env`; secrets do not.

Configure model source keys only in `/etc/cod/control-plane.env`, for example `KAI_API_KEY`. Additional sources can be supplied with `COD_MODEL_SOURCES_JSON`; each entry names an `apiKeyEnv`, so credentials stay outside the JSON and Git.

`deploy/control-plane.env.example` lists all production-only secret and integration settings. Do not copy real values into Git.

See `AUDIT_2026-08-10.md` for the latest verified production state, `FUNCTION_AUDIT.md` for the broader internal scope and external integration boundaries, `docs/KAI_ACCOUNT_INTEGRATION.md` for the reviewed KAI Account OIDC boundary and rollout gates, `docs/REGISTRATION_OPEN_RUNBOOK.md` for the OTP rollout gate, and `CLIENT_AUDIT_2026-08-11.md` for the latest Android, iOS, and Desktop validation.
