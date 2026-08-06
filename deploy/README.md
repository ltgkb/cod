# COD server deployment

The production Web build uses the same origin for control-plane requests. Nginx serves the PWA and proxies `/api/*` and `/v1/*` to the local control-plane service on port 8787.

Server files:

- `/etc/systemd/system/cod-control-plane.service`
- `/etc/nginx/sites-available/cod`
- `/var/www/cod`
- `/etc/cod/control-plane.env`
- `/etc/cod/runtime.env`

`control-plane.env` contains secrets, including `DATABASE_URL`. `runtime.env` contains only versioned non-secret settings such as the restricted pilot login account.

`cod.kai.com` must have an A record pointing to `95.41.23.60` before issuing a public TLS certificate.
