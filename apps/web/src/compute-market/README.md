# COD Compute Market V2 integration boundary

This directory is intentionally self-contained. COD mounts it as the full-screen replacement for the former V1 compute modal.

## Web mount

Mount `ComputeApp` when the compute rail entry is selected or the current URL begins with `/compute`. Pass the unified COD session, control-plane base URL, platform, login-return callback, exit callback, and optional COD task callback exactly as described by `ComputeAppProps` in `types.ts`.

Mount `ComputeAdminApp` only for an authenticated principal when `/api/compute/v2/capabilities` returns `admin: true`. Do not infer admin access from client state.

## Control-plane mount

Create one long-lived `createComputeMarketV2Router()` instance. In the main server, after origin/CORS processing and before V1 compute routes:

1. Parse the bearer session into a `ComputePrincipal` when present.
2. Read JSON only for V2 mutation methods.
3. Call `computeRequestFromNode(request, principal, body)` and then `router.route(...)`.
4. If the result is non-null, return its status/body through the shared JSON responder.
5. Keep V1 `/api/compute/offers` and `/api/compute/requests` unchanged during migration.

The included services use isolated in-memory repositories for review and tests. Production enablement must replace them with transactional Postgres/object-storage/metrics adapters, connect the shared COD card-hour ledger, and run the V1→V2 idempotent migration before `enabled` is exposed. Instant purchase, rankings, hosted settlements, card-hour trades, coupons, addresses, procurement, and human support remain capability-off until their real dependencies exist.

## Review gates

- Do not publish sample offers from frontend arrays. The default catalog is empty and only renders records returned by the API.
- COD card-hours are the platform settlement currency, stored in `*CardHoursMilli` amount fields. They are never a resource-usage measure.
- Rental SKUs use `period: 'hour'` only. Prices display as card-hours per hour and `availableDurationHours` records the integer resource-entitlement duration per rented unit; hosting contract terms remain month-based.
- Do not enable instant/reservation purchase until inventory locking, atomic card-hour settlement, delivery, and refund are connected.
- Replace the generic AI-generated GPU preview with SKU-accurate authorized media before publishing any real offer.
- Preserve tenant + owner checks, idempotency keys, optimistic revisions, reason fields, masked admin lists, and append-only audit summaries when implementing persistence.
