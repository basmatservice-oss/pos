# Android RC2 validation scope

This branch repairs the Android standalone RC startup path.

## Changes
- Load Node.js native libraries after the diagnostic startup screen is visible, and surface linker/JNI startup failures instead of silently exiting.
- Reset the Node-started guard if the embedded Node runtime exits or throws, so a later Activity start can retry.
- Link the Android JNI bridge with 16 KB maximum ELF page alignment to match the prebuilt Node.js runtime and modern Android devices.
- Keep native libraries uncompressed and require 16 KB ZIP alignment.
- Add CI checks for every packaged ELF LOAD segment and APK zip alignment.
- Run an Android API 35 x86_64 emulator smoke test for first launch, local SQLite initialization, owner bootstrap, local product persistence, force-stop, and process restart.

## Supported Android ABIs in this RC
The embedded Node.js and SQLite binaries are currently supplied for `arm64-v8a` and `x86_64`. This RC does not claim support for 32-bit ARM (`armeabi-v7a`) devices. Minimum Android API level remains 26 (Android 8.0).

## Acceptance rule
A successful Gradle build is not sufficient. The RC2 artifact is accepted only if the CI emulator test installs and starts the app, the local health endpoint reports SQLite ready, the local owner can authenticate, a product persists after force-stop/restart, and all 16 KB native alignment checks pass.