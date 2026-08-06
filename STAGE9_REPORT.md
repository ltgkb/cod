# COD Stage 9 Review

## Delivered

- Immutable revision releases under `/opt/cod/releases` with one atomic `/opt/cod/current` switch for both Web and control-plane artifacts.
- The control plane and runtime dependencies are bundled into a compact Node ESM artifact instead of copying the full development dependency tree.
- Releases are assembled in staging directories and renamed only when complete.
- The deployment gate runs clean install, typecheck, all tests, lint, production builds, and high-severity dependency audit before activation.
- Activation has a global rollback trap. Any failure after the current link changes restores the previous release, revision metadata, Nginx, and the control-plane service.
- `/health`, PostgreSQL-aware `/ready`, localhost-only `/metrics`, and localhost-only `/version` endpoints.
- Structured JSON request/error lifecycle logs with a request ID propagated from Nginx.
- Nginx rate limiting for API and model routes, immutable asset caching, and private metrics/version routes.
- Graceful SIGTERM shutdown closes the HTTP server and PostgreSQL pool before process exit.
- Daily PostgreSQL custom-format backups with checksum verification, private file permissions, and 14-day retention.
- A restore tool restricted to isolated `cod_restore_*` databases so drills cannot overwrite production.
- One-minute systemd health checks and persistent daily backup timers.

## Verification

- Complete release gates passed with one Web test and 13 control-plane tests, zero lint warnings, successful production builds, and zero npm audit vulnerabilities.
- A controlled post-activation failure returned a non-zero deployment result and automatically restored the old release, `/version`, and PostgreSQL readiness.
- A backup completed with `Result=success`, SHA-256 verification, mode `0600`, and `postgres:postgres` ownership.
- The backup restored into an isolated database; users, devices, tasks, ledger, and audit counts matched production exactly.
- Metrics returned 200 on localhost and 403 through the public address.
- An 80-request burst produced both authenticated-route responses and 429 rate-limit responses.
- The Nginx `X-Request-ID` response value appeared in the matching control-plane JSON log record.
- A systemd restart emitted `service.stopping` on SIGTERM and restarted with a new PID and a ready PostgreSQL connection.
- The compact release was approximately 1 MB instead of approximately 1.3 GB for the earlier dependency-copying layout.
- The public IP returned 200 for the Web app and pilot login API.

## Review adjustments

- Changed the deployment from copying `node_modules` to a compact ESM bundle after measuring unacceptable per-release disk growth.
- Added a CommonJS compatibility bridge for the PostgreSQL driver in the ESM bundle.
- Standardized every release on `start.mjs` so the systemd unit remains compatible across rollbacks.
- Added staging-directory assembly to prevent failed builds from appearing as complete revisions.
- Retained multiple valid revisions and removed only incomplete or superseded recovery artifacts after verification.

## Production boundary

- `cod.kai.com` still requires its public DNS A record before a trusted TLS certificate can be issued.
- Prometheus scraping, alert routing, log aggregation, and an external uptime monitor are not connected to third-party infrastructure yet; the local endpoints and timers are ready for them.
- Backups currently remain on the same server. A production disaster-recovery policy must copy encrypted backups to independent object storage and test retention there.
- The pilot runs on one application server and one local PostgreSQL instance; high availability and regional failover require additional infrastructure.
