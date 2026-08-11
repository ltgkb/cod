# COD server deployment

The production Web build uses the same origin for control-plane requests. Nginx serves the PWA and proxies `/api/*` and `/v1/*` to the local control-plane service on port 8787.

Server files:

- `/etc/systemd/system/cod-control-plane.service`
- `/etc/nginx/sites-available/cod`
- `/opt/cod/current/web`
- `/etc/cod/control-plane.env`
- `/etc/cod/runtime.env`

`control-plane.env` contains secrets, including `DATABASE_URL`. `runtime.env` contains only versioned non-secret settings such as the restricted pilot login account.

Start from `deploy/control-plane.env.example` and populate it only on the server. The model provider key, Wiki key, payment webhook secret, Feishu credentials/bindings, and Hong Kong SSO secret must never enter a desktop package, Web bundle, or Git commit.

`cod.kai.com` must have an A record pointing to `95.41.23.60` before issuing a public TLS certificate.

## Release and reliability

- `scripts/deploy-server.sh` runs the complete verification suite, creates an immutable revision directory under `/opt/cod/releases`, switches `/opt/cod/current`, checks readiness, and rolls the service back if the new revision does not become ready.
- Re-running the already active, complete revision is idempotent: verification still runs, but activation, service restart, and rollback-test injection are skipped.
- The control plane and its runtime dependencies are bundled into one Node ESM artifact. A release is built under a staging directory and renamed only after all files are complete, preventing partial releases.
- The release directory retains the active/previous revisions plus the newest recovery candidates instead of growing without bound.
- `cod-backup.timer` creates a verified custom-format PostgreSQL backup every day and keeps 14 days.
- `scripts/restore-database.sh` restores only into an explicitly named `cod_restore_*` database so recovery drills cannot overwrite production accidentally.
- `cod-healthcheck.timer` checks the control plane, PostgreSQL readiness, and Nginx every minute.
- `/metrics` and `/version` are available only through localhost at Nginx; public callers receive 403.
- The origin accepts application traffic only from the observed ALB subnet or localhost. Direct Internet requests for `cod.kai.com` are redirected to the HTTPS edge, and direct health probes receive 404.
- The control plane runs without Linux capabilities, access to host IPC, namespace creation, clock/hostname mutation, or visibility into other users' processes.
