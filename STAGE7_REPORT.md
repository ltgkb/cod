# COD Stage 7 Review

## Delivered

- Added a typed product registry for `hongkong.kai.com`.
- Added the Hong Kong product entry to the shared COD workspace rail.
- Default launch behavior opens the product in a separate browser context with `noopener` and `noreferrer`.
- Embedded mode is disabled by default and can only be enabled explicitly with `KAI_HONGKONG_EMBED_ENABLED=true`.
- Embedded content uses a restricted iframe sandbox and a server-owned allowed-origin manifest.

## Verification

- Product registry test confirms that embedded mode is off by default.
- Control-plane tests, Web test, typecheck, lint, production build, and dependency audit passed.
- The product API and UI use the shared `ProductManifest` contract.

## Review and adjustments

- Keep external launch as the production default until Hong Kong publishes an approved embed URL and framing policy.
- Before enabling embedding, verify CSP `frame-ancestors`, cookie behavior, SSO handoff, logout, and tenant isolation.
- Treat the allowed-origin list as control-plane configuration rather than accepting origins from the client.
- Do not expose Hong Kong credentials or privileged session tokens to the iframe URL.

## External dependencies

- Production URL and embed route from the Hong Kong team.
- CSP and cross-origin policy confirmation.
- SSO/session exchange contract and tenant binding.
- Product icon and final navigation copy.
