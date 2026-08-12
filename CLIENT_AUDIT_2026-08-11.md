# COD client audit — 2026-08-11

## Outcome

Android and macOS Desktop were exercised manually after rebuilding from this branch. The Web, Mobile, Desktop, and control-plane automated suites also pass. iOS bundles successfully, but a real iOS simulator run is not claimed because this host has Command Line Tools only and no full Xcode or `simctl` runtime.

`Kai_Zanzibar_Next` should not be merged into this monorepo as source or infrastructure. It is a separate identity control plane. COD should consume its OIDC Broker through the boundary documented in `docs/KAI_ACCOUNT_INTEGRATION.md`; no OAuth client or persistent credential was created during this audit.

## Client fixes included

- Android hardware Back now dismisses the keyboard first when applicable, then the active modal or task sidebar, and only returns to the system at the workspace root.
- Modal headers stay visible while long content scrolls. The close control no longer inherits the navigation rail's automatic margins and remains at the upper-right edge with a 42 by 40 CSS-pixel target.
- Mobile context is one compact row: knowledge, device handoff, and More are the three exposed secondary controls. Lower-priority project, diff, permission, source, and price context expands on demand.
- Native hosts no longer show the unusable local-project attachment control or a macOS keyboard shortcut hint.
- Desktop restores and displays the selected project before Git inspection completes. File listing and Diff load independently; an invalid project is removed or rolled back to the last validated project instead of leaving a phantom root.
- Git probes and automatic diffs have hard timeouts. Automatic diffs disable external diff drivers and text conversion.
- Desktop development now starts a loopback renderer and in-memory control plane by default, with an explicit `COD_DEV_DATABASE_URL` opt-in for a development database. Production database and control-plane secrets are shadowed.
- Electron development navigation uses parsed exact-origin matching; crafted user-info and prefix URLs are rejected.
- Node 24.16+/26 Electron extraction is made reproducible by overriding `yauzl` to 3.3.1. npm 11 has an explicit install-script approval list; this is forward-compatible policy, not a hard gate under the repository's current npm 10 CI.

## Manual validation

| Target | Environment | Result |
|---|---|---|
| Android | Pixel 7, API 36 Google APIs image, Expo Go | Cold launch, production capability load, responsive layout, one-row collapsed context, More expansion, login modal, keyboard dismissal, sticky header, reachable close control, and hardware Back passed. A production mobile task also completed and appeared on Desktop as `MOBILE_OK`. |
| iOS | Expo SDK 57 export | JavaScript, DOM, CSS, and Hermes export passed. Native callback, Keychain, Universal Link, process-death, and simulator UI flows remain unverified. |
| macOS Desktop | arm64 packaged `.app`, Electron 39.8.10 | Production session recovery, project recovery, 185-file browser, file preview, Diff timeout fallback, model/task state, and allowlisted terminal command passed. Ad-hoc signature passed strict deep verification. |

The initial Android test used the automated-test-device image and showed a black surface even though the WebView DOM was complete. Log inspection isolated this to the emulator/WebView graphics path. Re-running the same bundle on the Google APIs Pixel 7 image with SwiftShader produced the expected UI; no React or application crash was present.

## Automated validation

The release gate covers:

- TypeScript checks for Web, Mobile, Desktop, and control plane
- Web, Mobile, Desktop, and control-plane tests
- Web lint and all production builds
- Expo Doctor and both iOS and Android exports
- Desktop development registration/login smoke test
- macOS DMG and ZIP packaging plus strict deep code-signature verification
- whitespace/error checks with `git diff --check`

## Open findings and release gates

1. KAI Account production sign-in remains blocked on the exact OAuth clients, redirect URIs, ownership, and secret-handling approval. Web confidential/BFF should ship before native public clients.
2. The KAI Account audit found a password-change/session-invalidation ordering risk, best-effort high-risk audit writes, an unwired authorization service, asymmetric database-role convergence, filename-only migrations, an unreproducible committed lock under npm 11, long-lived Login V2 PAT defaults, in-memory passkey ceremonies, and non-digest-pinned production images. Its source passed 1,212 tests after diagnostic lock regeneration; PostgreSQL integration tests were not run because Docker was unavailable. The repository also has no committed `LICENSE`, so direct source copying lacks documented reuse terms.
3. COD's current dependency audit reports 19 transitive findings (11 high, 8 moderate) in the Expo/React Native/Metro build toolchain. The suggested forced fix is a major downgrade and was not applied. Treat untrusted images and build inputs as a build-host risk until upstream versions are available.
4. The main Web chunk is about 553 KB minified. Route- or feature-level code splitting remains a performance follow-up.
5. Expo Go does not validate native OIDC deep links, secure credential storage, cold-start callbacks, or process-death recovery. Those require signed development builds on both mobile platforms.
6. COD client sessions are still stored in renderer/WebView local storage instead of platform credential stores. That must change before enabling native KAI Account clients.
7. A production task created during earlier permission testing remained `running` for hours after its local runner disappeared. The server needs lease expiry/reconciliation and a clearer stale-task recovery action.
8. The mobile bottom rail exposes seven destinations. It fits the tested Pixel viewport with 42 by 40 CSS-pixel controls, but information architecture should reduce it to five primary destinations before adding more products.

This branch is an integration and client-hardening review. It does not deploy production, modify the KAI Account repository, create OAuth credentials, or merge the two service stacks.
