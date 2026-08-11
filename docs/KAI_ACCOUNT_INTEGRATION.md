# KAI Account integration decision

Status: proposed, blocked on OAuth client registration and the security gates below.

Reviewed inputs:

- COD commit `8303f47`
- `Kai_Zanzibar_Next` production commit `f1b0c81959f23ff03c4bce0f24ef574e1812afda`
- Live issuer discovery at `https://account.kai.com/connect/.well-known/openid-configuration`

## Decision

Do not copy or merge the KAI Account services, databases, sessions, memberships, or SQL authorization service into COD. Keep KAI Account deployed as an independent identity control plane and connect COD to its public OIDC Broker over HTTPS.

The reviewed repository also has no committed `LICENSE` file. Even within the same organization, copying its implementation into COD would leave provenance and redistribution terms undocumented. Resolve that independently if source reuse is ever proposed; the OIDC integration described here does not require source reuse.

COD remains authoritative for:

- COD users, tenants, roles, wallets, credit packs, tasks, devices, models, and Agent sessions
- application session creation, rotation, revocation, and logout
- every business authorization decision made by COD

KAI Account is authoritative only for proving an external identity. The stable lookup key is `(issuer, subject)`. Email is mutable profile data and must never be used to silently link accounts.

The Broker access token is only for the Broker UserInfo and avatar endpoints. It is not a COD API bearer and must never be passed to Goose or another model provider.

## Required server model

Add identity mapping without changing existing COD business foreign keys:

```sql
CREATE TABLE cod_external_identities (
  issuer text NOT NULL,
  subject text NOT NULL,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  email_snapshot text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer, subject),
  FOREIGN KEY (tenant_id, user_id)
    REFERENCES cod_users (tenant_id, user_id)
    ON DELETE CASCADE
);
```

New OIDC users receive a random internal `user_id`. The configured COD client determines the tenant. Neither the email domain nor KAI Account Organization role determines a COD tenant or role.

Use a one-time server-side login transaction containing:

- a digest of `state`
- `nonce`
- the PKCE verifier protected at rest
- the intended COD client and safe post-login destination
- optional onboarding or referral context
- creation and expiry timestamps
- a consumed timestamp

Replace the current seven-day self-contained bearer for OIDC sessions with an opaque, hashed, server-revocable COD session. Provider tokens must be discarded after claims are verified and the required profile is resolved.

## Protocol contract

The only accepted issuer is:

```text
https://account.kai.com/connect
```

Use Authorization Code with PKCE S256. Validate all of the following before mapping a user:

- exact HTTPS issuer
- ES256 signature through the discovered JWKS
- audience and `azp` where applicable
- expiry, issued-at time, nonce, state, and one-time transaction consumption
- redirect URI and client identity for the initiating platform

Start with `openid email`. Add `kai:name` only when COD displays the name. Treat `kai:organization_membership` as an optional login admission signal only; its current boolean value cannot authorize COD resources.

KAI Account roles must not map to COD roles. In particular, KAI Account `admin` must never become COD `admin`, because COD administrators can ingest usage and are exempt from billing.

## Client separation

Register a distinct OAuth client for every platform and environment:

| Client | Type | Callback | Session storage |
|---|---|---|---|
| COD Web | confidential | `https://cod.kai.com/api/auth/oidc/callback` | Secure, HttpOnly COD cookie |
| COD iOS | public native | verified Universal Link, with an app-specific scheme only as fallback | Keychain |
| COD Android | public native | verified App Link, with an app-specific scheme only as fallback | Keystore-backed secure storage |
| COD Desktop | public native | app-specific protocol with cold-start and second-instance forwarding | OS credential store |

Do not share client IDs between development, staging, and production. Do not put the Web client secret in a renderer, Expo bundle, Electron archive, mobile application, or repository.

The existing Expo DOM shell and Electron renderer are not ready for native OIDC callbacks. Before enabling those clients, add a platform-owned authentication bridge with this shared interface:

```text
beginLogin()
completeLogin(callback)
resumeSession()
authenticatedRequest()
logout()
```

Expo Go remains suitable for layout and shared-DOM testing. App Links, Universal Links, secure storage, callback cold starts, and process-death recovery require development or production builds.

## Existing user migration

Use hybrid mode during migration:

1. Existing users sign in to COD with their current credential.
2. They explicitly choose to link KAI Account.
3. COD verifies a new `(issuer, subject)` and attaches it to the already authenticated COD user.
4. A matching email alone never authorizes a link.
5. When an unlinked KAI identity has an email already present in COD, stop and offer the explicit linking flow or administrator-assisted recovery.

For a new KAI identity, create the COD user, external identity, referral relation, and trial credit in one transaction. Replaying the callback must not issue a second trial or overwrite an existing mapping.

## Deployment and logging

Keep the two deployment stacks and databases independent. COD only needs outbound HTTPS access to discovery, authorization, token, UserInfo, and JWKS endpoints.

Store Web client configuration in the control-plane environment, for example:

```text
COD_AUTH_MODE=hybrid
KAI_ACCOUNT_OIDC_ISSUER=https://account.kai.com/connect
KAI_ACCOUNT_OIDC_CLIENT_ID=...
KAI_ACCOUNT_OIDC_CLIENT_SECRET=...
KAI_ACCOUNT_OIDC_REDIRECT_URI=https://cod.kai.com/api/auth/oidc/callback
```

The callback route must not log its query string. Never log authorization codes, state, nonce, PKCE verifier, provider tokens, COD session tokens, or raw provider error descriptions.

## Security gates before production enablement

The source repository passed type checking, its build, 1,212 tests, and npm vulnerability scanning after regenerating its lock metadata. PostgreSQL integration tests were skipped because no Docker daemon was available. The following findings should be fixed before COD depends on it for production sign-in:

1. Password mutation occurs before durable local session invalidation. A database failure can leave another local session valid for up to the configured eight-hour TTL after the upstream password has changed.
2. High-risk security audit writes are best-effort and can be silently lost. Use a durable mutation intent or outbox and reconcile a terminal audit event.
3. The advertised Zanzibar authorization service is implemented but not wired into the Account runtime. COD must not depend on it as a policy decision point.
4. Runtime PostgreSQL role convergence is asymmetric. Account and Broker roles need the same membership cleanup, attribute reset, and credential rotation checks as Registration.
5. Applied migrations are tracked only by filename. Add checksums and reject modified or out-of-order migrations.
6. The committed npm lock is incomplete on npm 11, lacks integrity metadata for many registry packages, and does not reproduce a clean install. Regenerate it with the supported toolchain and pin `packageManager`.
7. Login V2 PAT defaults to a far-future expiry and has no implemented rotation and revocation workflow.
8. Passkey ceremonies use a bounded in-memory store. Move them to a shared consume-once store before horizontal scaling.
9. Pin production image digests consistently, including the main application, Traefik, and PostgreSQL images.

## Delivery sequence

1. Fix KAI Account P1/P2 security gates and its reproducible lock file.
2. Register only the COD Web development client.
3. Implement external identity mapping, one-time OIDC transactions, revocable COD sessions, and explicit account linking behind `COD_AUTH_MODE=hybrid`.
4. Exercise cancellation, replay, wrong issuer/audience, expired code, key rotation, 429/503, and account-link conflicts.
5. Enable Web production gradually with metrics and a password-login rollback path.
6. Add separate iOS, Android, and Desktop public clients and test real packaged callback flows.
7. Remove password login only after linked-user coverage and recovery procedures are proven.

OAuth client creation is intentionally not part of this change. It creates persistent access and must be performed only after the exact clients, redirect URIs, owners, and secret-handling path are approved.
