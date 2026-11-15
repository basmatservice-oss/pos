# DavinciPos temporary RC packaging

This branch adds experimental packaging targets only. It does not change the legacy application or the production branch.

## Windows EXE

From this directory, run:

```sh
npm install
npm run package:win
```

The NSIS installer is written to `dist/`. It starts the Node/Express service on loopback port 3187 and stores its SQLite database in the operating system's per-user application-data directory. It is a standalone desktop preview; it does not yet expose the Windows-hosted service to other LAN devices. LAN hosting remains on the existing HTTPS-configured Node server path until a managed certificate enrollment flow is implemented and tested.

On first launch, copy the one-time bootstrap token displayed by the desktop shell and enter it in the owner-creation screen. Keep the token private.

## Android APK

Build a debug APK with JDK 17 and Android SDK 35:

```sh
gradle --no-daemon -p android assembleDebug
```

Output: `android/app/build/outputs/apk/debug/app-debug.apk`.

The Android app is a WebView client, not a local database server. On first launch, enter the HTTPS URL of a DavinciPos host on the same LAN, ending in `/mobile`. Example: `https://192.168.1.10:3000/mobile`. Internet access is not needed, but the host must be reachable over the local network and must present a certificate trusted by Android. Install the managed local CA certificate on the Android device before connecting; do not bypass certificate warnings. The app permits system and user-installed trust anchors, but it does not install certificates itself.

## Temporary CI artifacts

The workflow `.github/workflows/davincipos-rc-packaging.yml` builds the Windows installer and Android debug APK as separate GitHub Actions artifacts. They are temporary (14-day retention), unsigned test artifacts, not production releases. A successful build workflow is required before distributing either file.

## Known limits of this RC

- The EXE is currently a single-computer desktop preview bound to 127.0.0.1; it is not yet the shared LAN host for the APK.
- The APK requires an already running HTTPS DavinciPos host on the same LAN.
- Android offline queue behavior, WebView IndexedDB persistence, and real multi-device reconnect still require device acceptance testing.
- No production signing, installer signing, update mechanism, or final data migration is included.
- These preview files and the packaging branch are temporary. The final release will be rebuilt from the merged, accepted source and signed separately.

Do not use this preview with real customer or financial data. Use test data only.
