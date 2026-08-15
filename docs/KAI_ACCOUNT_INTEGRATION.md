# KAI Identity integration

Status: Web OIDC client implemented behind `COD_AUTH_MODE`; production activation requires a registered client ID and secret in the server environment.

Reviewed inputs:

- COD commit `8303f47`
- `Kai_Zanzibar_Next` production commit `f1b0c81959f23ff03c4bce0f24ef574e1812afda`
- Live issuer discovery at `https://auth.kai.com/api/auth/.well-known/openid-configuration`

## Decision

Do not copy or merge the KAI Identity services, databases, or sessions into COD. Keep it as an independent identity provider and connect COD to its public OIDC endpoints over HTTPS.

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

New OIDC users receive a non-guessable internal `user_id` derived from the stable issuer and subject. The configured COD client determines the tenant. Neither the email domain nor a KAI Identity role determines a COD tenant or role.

The implementation uses a one-time, ten-minute server-side login transaction containing:

- a digest of `state`
- `nonce`
- the PKCE verifier
- a validated relative post-login destination
- an expiry timestamp

After the callback, COD issues a one-time, 60-second browser exchange code and then creates its own signed session. Provider tokens are discarded after claims are verified and the required profile is resolved. Moving all COD sessions to opaque, hashed, server-revocable records remains a follow-up hardening item.

## Protocol contract

The only accepted issuer is:

```text
https://auth.kai.com/api/auth
```

Use Authorization Code with PKCE S256. Validate all of the following before mapping a user:

- exact HTTPS issuer
- EdDSA signature through the discovered JWKS
- audience and `azp` where applicable
- expiry, issued-at time, nonce, state, and one-time transaction consumption
- redirect URI and client identity for the initiating platform

Use `openid profile email`. Require a verified email. Identity-provider roles or organization claims must never authorize COD resources.

KAI Identity roles must not map to COD roles. In particular, an identity-provider `admin` must never become COD `admin`, because COD administrators can ingest usage and are exempt from billing.

## Client separation

Register a distinct OAuth client for every platform and environment:

| Client | Type | Callback | Session storage |
|---|---|---|---|
| COD Web | confidential | `https://cod.kai.com/api/auth/kai/callback` | COD session token after one-time callback exchange |
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
KAI_IDENTITY_OIDC_ISSUER=https://auth.kai.com/api/auth
KAI_IDENTITY_OIDC_CLIENT_ID=...
KAI_IDENTITY_OIDC_CLIENT_SECRET=...
KAI_IDENTITY_OIDC_REDIRECT_URI=https://cod.kai.com/api/auth/kai/callback
KAI_IDENTITY_OIDC_TENANT_ID=tenant_kai_identity
```

The callback route must not log its query string. Never log authorization codes, state, nonce, PKCE verifier, provider tokens, COD session tokens, or raw provider error descriptions.

## Security gates before production enablement

- Register the exact production callback and deliver the client secret only through the server environment.
- Exercise callback replay, wrong issuer/audience, nonce mismatch, expired tokens, key rotation, rate limiting, and provider outage.
- Add an explicit authenticated linking flow for existing COD emails; matching email alone is deliberately rejected.
- Move OIDC transaction and exchange-ticket state to a shared consume-once store before running multiple control-plane replicas.
- Replace self-contained COD sessions with opaque, hashed, server-revocable records.

## Delivery sequence

1. Fix KAI Account P1/P2 security gates and its reproducible lock file.
2. Register the COD Web client with the exact callback URI.
3. Supply the OIDC environment variables and enable `COD_AUTH_MODE=hybrid` first.
4. Exercise cancellation, replay, wrong issuer/audience, expired code, key rotation, 429/503, and account-link conflicts.
5. Enable Web production gradually with metrics and a password-login rollback path.
6. Add separate iOS, Android, and Desktop public clients and test real packaged callback flows.
7. Remove password login only after linked-user coverage and recovery procedures are proven.

OAuth client creation remains an identity-administrator action. Do not commit the client secret or expose it to the browser, mobile bundle, or desktop renderer.
