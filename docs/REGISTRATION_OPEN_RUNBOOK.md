# Open registration runbook

Status: the controlled internal beta currently uses direct email-and-password registration (`COD_REGISTRATION_ENABLED=true`, `COD_REGISTRATION_VERIFICATION_REQUIRED=false`). This mode does not mark email or phone as verified and must not be used for public launch. The steps below are still required before switching `COD_REGISTRATION_VERIFICATION_REQUIRED=true`. No step in this runbook commits secrets to Git, chat, or terminal output.

This runbook complements `COD_PROJECT_HANDOFF_2026-08-12.md`. The code changes in this round close the outbound DNS-rebinding TOCTOU, unify the decoy/resend semantics so accounts cannot be enumerated by status or timing, fill the env-example gaps, and add a fail-closed guard on the email-domain allowlist. None of these changes open registration by themselves.

## 0. What is already done in code

- **Outbound IP pinning.** `assertSafeRegistrationEndpoint` now returns the validated public IP, and both the Turnstile siteverify call and the OTP delivery webhook connect to that exact IP via a pinned `lookup` (TLS SNI/Host and certificate validation stay bound to the URL hostname). A DNS record that rebinds to a private address between validation and connect can no longer reach the socket.
- **Decoy/resend parity.** The already-registered (decoy) start path now consumes a per-destination 1-per-`resendSeconds` cooldown and returns the same `resendAt` as a real first start. A repeat start inside the window returns `429 retry-after:60` for both new and existing accounts, so an attacker cannot distinguish them by HTTP status, `retry-after`, or `resendAt`. A small jittered delay narrows (does not fully eliminate) the timing side-channel.
- **Env example.** `deploy/control-plane.env.example` now documents `COD_TURNSTILE_EXPECTED_HOSTNAMES`, `COD_REGISTRATION_OUTBOUND_ALLOWED_HOSTS`, `COD_TURNSTILE_VERIFY_URL`, and `COD_TURNSTILE_EXPECTED_ACTIONS`.
- **Email-domain fail-closed guard.** `config.ts` rejects an empty `COD_ALLOWED_EMAIL_DOMAINS` in production, so a misconfigured empty value can never silently become "allow all". `deploy/runtime.env` currently lists `kai.com,163.com,126.com,gmail.com,qq.com,vn.com` for beta; operators must keep this list explicit and reviewed.

Verification this round: control-plane 168 tests pass, root typecheck pass (web + mobile + desktop + control-plane), web lint 0 warnings, root build pass, `npm run audit:high` pass (production high/critical = 0; the only remaining advisories are the pre-existing Expo/Metro transitives `GHSA-w3rx-r6r6-pgpr` and `GHSA-5p2g-fcmc-qvqq`, due for review by 2026-09-11).

## 1. Stand up the OTP forwarding service (generic HTTPS webhook)

COD does not bind any email/SMS vendor SDK. It POSTs an OTP to two generic HTTPS webhooks you operate. Each webhook receives a JSON body:

```json
{ "type": "cod.registration.otp", "channel": "email" | "sms",
  "challengeId": "uuid", "destination": "user@kai.com" | "+14155550123",
  "code": "123456", "expiresAt": "2026-08-12T00:10:00.000Z" }
```

- `authorization: Bearer <token>` authenticates the call.
- The webhook host must be HTTPS, port 443, no URL credentials, no fragment, and its hostname must be listed in `COD_REGISTRATION_OUTBOUND_ALLOWED_HOSTS`.
- Your service forwards `destination`/`code` to whichever email/SMS provider you chose. Keep provider API keys inside that service, never in COD env.
- Respond `2xx` only after the provider accepts the message; respond non-2xx so COD returns `503 registration_delivery_failed` and invalidates the challenge code (no OTP left usable).
- Add per-destination throttling/queueing inside the forwarder if your provider needs it; COD already enforces 3 sends per channel, 60s resend, 10-min OTP TTL, and IP/destination rate limits upstream.

## 2. Provision Cloudflare Turnstile

- Create a Turnstile widget in the Cloudflare dashboard. Allowed hostname: `cod.kai.com` (the public page that hosts the registration form). Add every hostname that renders the form to `COD_TURNSTILE_EXPECTED_HOSTNAMES`.
- The two actions are hardcoded and must stay exactly: `cod_registration_email` and `cod_registration_phone`. Do not change `COD_TURNSTILE_EXPECTED_ACTIONS`.
- Copy the site key and secret key; they go into the root-only server env (section 3). The site key is public (returned in `/api/capabilities`); the secret is server-only.

## 3. Generate root-only server secrets

Edit `/etc/cod/control-plane.env` on the production host (root-only, never committed). systemd loads this file before `/etc/cod/runtime.env`, so an incomplete or drifted secret file keeps registration closed (config validation fails closed). Populate:

```text
COD_REGISTRATION_HMAC_KEY=base64url:<exactly 32 random bytes>
COD_REGISTRATION_EMAIL_WEBHOOK_URL=https://<your-email-webhook-host>/cod/email
COD_REGISTRATION_EMAIL_WEBHOOK_TOKEN=<email-webhook-bearer>
COD_REGISTRATION_SMS_WEBHOOK_URL=https://<your-sms-webhook-host>/cod/sms
COD_REGISTRATION_SMS_WEBHOOK_TOKEN=<sms-webhook-bearer>
COD_TURNSTILE_SITE_KEY=<public-site-key>
COD_TURNSTILE_SECRET_KEY=<secret-key>
COD_TURNSTILE_VERIFY_URL=https://challenges.cloudflare.com/turnstile/v0/siteverify
COD_TURNSTILE_EXPECTED_HOSTNAMES=cod.kai.com
COD_TURNSTILE_EXPECTED_ACTIONS=cod_registration_email,cod_registration_phone
COD_REGISTRATION_OUTBOUND_ALLOWED_HOSTS=<email-webhook-host>,<sms-webhook-host>
```

- `COD_REGISTRATION_HMAC_KEY`: exactly 32 bytes, prefixed `base64url:` or `base64:`. Generate with `openssl rand 32 | base64` and prefix `base64url:`.
- The webhook hostnames in `COD_REGISTRATION_OUTBOUND_ALLOWED_HOSTS` must exactly match the hosts in the two `*_WEBHOOK_URL` values (config cross-checks them).
- `/etc/cod/runtime.env` (non-secret policy) may keep the controlled beta open with `COD_REGISTRATION_ENABLED=true` and `COD_REGISTRATION_VERIFICATION_REQUIRED=false`. Do not set verification to `true` until section 4 passes.

## 4. Smoke-test real delivery, then open the switch

Do not flip the switch on first try. Use a staging host or a canary release:

1. Deploy the new release with `scripts/deploy-server.sh` (it refuses dirty worktrees, builds an immutable release, switches the symlink, checks readiness, and rolls back on failure).
2. Confirm `/api/capabilities` returns `authentication.registrationEnabled=false` but `turnstileSiteKey` is now set and `publicRegistrationUrl` is present.
3. Temporarily set `COD_REGISTRATION_ENABLED=true` only on the canary host (edit `/etc/cod/runtime.env`, `systemctl restart cod-control-plane`), then verify the full matrix with real `@kai.com` and beta-domain emails:
   - Real email OTP received within seconds; code is 6 digits; masked destination is correct.
   - Real SMS OTP received on an E.164 test number.
   - Expired code (after 10 min) rejected; resend within 60 s returns `429 retry-after:60`; 4th send on the same challenge is locked.
   - Wrong code 5 times locks the challenge; duplicate final submission with the same idempotency key replays exactly; different payload with the same key returns `409`.
   - Already-registered email and already-registered phone return the same `202` contract (no enumeration by status/timing/resendAt).
4. After the matrix passes, leave the canary on for 24h with monitoring, then promote by setting `COD_REGISTRATION_ENABLED=true` in the production `/etc/cod/runtime.env` and redeploying.
5. Roll back by setting `COD_REGISTRATION_ENABLED=false` and restarting; secrets can stay in place.

## 5. Beta email-domain policy

`deploy/runtime.env` lists `COD_ALLOWED_EMAIL_DOMAINS=kai.com,163.com,126.com,gmail.com,qq.com,vn.com`. This list is the beta policy; it is NOT a security boundary (anyone can register a free mailbox on these providers) and must be reviewed before wider release. To change it, edit `deploy/runtime.env` (committed) AND update `/etc/cod/runtime.env` on the server, then redeploy. An empty value fails closed and blocks all registration.

## 6. Residual risks accepted this round

- **Timing side-channel (mitigated, not eliminated).** The decoy path adds a small jittered delay but cannot fully match the variance of a real outbound webhook. Residual risk is bounded by IP/destination rate limits and the 429/resendAt parity. Revisit if you observe probing.
- **Concurrent migration not docker-tested here.** `ensureGlobalEmailUniqueIndex` (advisory lock + duplicate pre-check + `CREATE UNIQUE INDEX CONCURRENTLY` + revalidate) is covered by unit tests and is already live and valid in production. A real-PostgreSQL concurrent-write stress test was skipped because the local Docker daemon was unavailable. Run it before any schema recreation: bring up a disposable `postgres`, insert concurrent rows during `CREATE UNIQUE INDEX CONCURRENTLY`, and confirm the advisory lock serializes the second instance and duplicates are rejected with `database_migration_blocked`.
- **Outbound egress ACL.** IP pinning prevents DNS rebinding at the application layer. For defense in depth, also restrict egress at the host/firewall layer so the control plane can only reach `challenges.cloudflare.com` and the webhook hostnames in `COD_REGISTRATION_OUTBOUND_ALLOWED_HOSTS`.
