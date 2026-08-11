# COD multi-platform distribution

COD uses one React application with an Electron desktop shell and Capacitor mobile shells. Production clients call `https://cod.kai.com`; local Electron Agent traffic is limited to its loopback Goose sidecar.

## Reproducible builds

```bash
npm ci
npm run package:mac
npm run package:win
npm run package:linux
npm run package:android
npm run package:ios
```

`package:mac` creates an ad-hoc signed QA build after applying security settings. Electron Builder signs every framework and helper with the required Electron runtime entitlements, including disabled Team-ID library validation for the ad-hoc build. Browser-downloaded builds still require Gatekeeper approval. Release automation with a Developer ID certificate must use `npm run package:mac:signed`, followed by Apple notarization and stapling.

The desktop packaging command automatically selects the Goose binary matching the build runner's operating system and CPU architecture. A manually supplied release binary can be selected with `COD_GOOSE_BINARY`.

The manually dispatched `Publish installers` GitHub Actions workflow publishes a
versioned GitHub prerelease containing these native-runner builds:

- macOS ARM installer (`.dmg`) and portable archive (`.zip`)
- Windows installer (`.exe`)
- Linux AppImage and Debian package
- Android debug-signed APK
- iOS Simulator application archive

Packages are uploaded directly to the draft release, so they do not consume
GitHub Actions artifact storage. The draft is published only after every build
and verification job succeeds. If a job fails, the incomplete draft remains
private until the workflow is rerun or the draft is removed.

## Signing boundary

Local or CI artifacts built without credentials are test artifacts. Public distribution additionally requires:

- Apple Developer ID Application certificate, notarization credentials, and an iOS distribution profile
- Windows Authenticode certificate
- Android upload keystore and Play App Signing configuration

Secrets belong in the CI secret store, never in this repository. The unsigned macOS/Windows packages and iOS Simulator build are useful for QA but are not App Store, Gatekeeper, or SmartScreen ready.

## Native build prerequisites

- macOS desktop: macOS runner; signing requires an Apple certificate
- Windows desktop: Windows runner
- Android: JDK 21 and Android SDK 36
- iOS: full Xcode; an actual `.ipa` requires an Apple team and provisioning profile

The web assets use relative paths so the same release works over HTTPS, `file://`, and Capacitor's native origin. Capacitor origins (`https://localhost` and `capacitor://localhost`) must remain in `COD_ALLOWED_ORIGINS`.
