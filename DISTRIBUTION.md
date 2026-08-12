# COD multi-platform distribution

COD uses one React application with an Electron desktop shell and an Expo mobile shell. The Expo app renders the shared workspace as a DOM Component while native actions own HTTP requests, external links, clipboard access, safe areas, and status-bar integration.

Production clients call `https://cod.kai.com`; local Electron Agent traffic is limited to its loopback Goose sidecar.

## Reproducible builds

```bash
npm ci
npm run package:mac
npm run package:win
npm run package:linux
npm run export:android
npm run export:ios
```

The two `export:*` commands create platform-specific Expo bundles under `apps/mobile/release/`. They validate that Metro can compile the Android and iOS applications, but they are not installable APK, AAB, IPA, or `.app` packages.

To run the mobile app during development, start Metro and open a matching Expo Go client:

```bash
adb reverse tcp:8787 tcp:8787
EXPO_PUBLIC_COD_CONTROL_PLANE_URL=http://127.0.0.1:8787 npm run mobile
```

The `adb reverse` line makes the Android emulator's guest `127.0.0.1:8787` reach the host control plane. Press `a` for Android or `i` for iOS. A physical device must use a control-plane URL reachable from that device instead of `127.0.0.1`.

## Installable mobile builds

Use EAS Build for installable or store-ready mobile artifacts. Link the Expo project once with `npx eas-cli init`, then configure build profiles and credentials before running `npx eas-cli build --platform android` or `npx eas-cli build --platform ios`. The project ID produced by that linking step is deployment-specific and must not be fabricated in source control.

## Desktop packaging

`package:mac` creates an ad-hoc signed QA build after applying security settings. Electron Builder signs every framework and helper with the required Electron runtime entitlements, including disabled Team-ID library validation for the ad-hoc build. Browser-downloaded builds still require Gatekeeper approval. Release automation with a Developer ID certificate must use `npm run package:mac:signed`, followed by Apple notarization and stapling.

The desktop packaging command automatically selects the Goose binary matching the build runner's operating system and CPU architecture. A manually supplied release binary can be selected with `COD_GOOSE_BINARY`.

GitHub Actions builds desktop installers on native runners and validates both Expo platform bundles. CI Expo bundles are compile-test artifacts; public mobile distribution still goes through EAS Build and the relevant store.

The manually dispatched `Publish installers` GitHub Actions workflow publishes a versioned GitHub prerelease containing:

- macOS ARM installer (`.dmg`) and portable archive (`.zip`)
- Windows installer (`.exe`)
- Linux AppImage and Debian package
- Android and iOS Expo compile-test bundles

Packages are uploaded directly to the draft release, so they do not consume
GitHub Actions artifact storage. The mobile bundles prove Metro compilation but are not APK, AAB, IPA, or `.app` packages. The draft is published only after every build
and verification job succeeds. If a job fails, the incomplete draft remains
private until the workflow is rerun or the draft is removed.

## Signing boundary

Local or CI artifacts built without credentials are test artifacts. Public distribution additionally requires:

- Apple Developer ID Application certificate and notarization credentials for macOS
- Apple Developer account and iOS distribution credentials
- Windows Authenticode certificate
- Android upload keystore and Play App Signing configuration

Secrets belong in the CI secret store, never in this repository.

## Native prerequisites

- macOS desktop: macOS runner; signing requires an Apple certificate
- Windows desktop: Windows runner
- Expo Go on Android: Android SDK, emulator, and an Expo Go version matching the project SDK
- Expo Go on iOS Simulator: full Xcode and a matching Expo Go simulator client
- Store builds: EAS Build credentials, or locally generated native projects with the complete Android/Xcode toolchain

The Expo DOM Component uses a native HTTP action, so mobile API calls do not depend on a WebView origin or permissive CORS configuration. Regular browser clients still use the normal web-origin allowlist.
