# Android Standalone Architecture Decision

Status: Proposed; implementation is gated by a runnable Android database/runtime spike.
Branch: `feature/davincipos-android-standalone`
Base: packaging RC branch `build/davincipos-packaging-rc1`.

## Product acceptance target

The Android APK is a complete, installable DavinciPos terminal. It must:
- start and operate without internet and without a Windows/Linux host;
- contain the actual DavinciPos business rules, UI assets, API, and a private persistent database;
- retain products, settings, users, sales, purchase receipts, returns, payments, expenses, inventory movements, and pending sync operations after force-stop/restart;
- support the full connected LAN mode against the store host, with authenticated HTTPS and certificate validation;
- queue disconnected-terminal sales durably and reconcile them idempotently when LAN connectivity returns;
- expose clear local/connected/sync/conflict/rejected states and never label an estimated offline quote as a posted central sale.

No APK is accepted merely because Gradle produces an APK.

## Findings from the current source

- The application backend is a Node.js/Express service.
- `database.js` imports `better-sqlite3` directly and exposes its synchronous API to all business modules.
- `package.json` declares Node.js >=20 and `better-sqlite3` ^12.8.0.
- The current Android project is only a WebView URL launcher. It has no local API, business rules, or database and is not a standalone app.
- The existing browser IndexedDB queue is a client cache/outbox, not a replacement for the authoritative SQLite database or the full business backend.
- The current desktop Electron shell starts a local server on 127.0.0.1; it is not yet a LAN host.

## Candidate implementation paths

### A. Embed Node.js Mobile and the existing backend

Node.js Mobile provides Android `libnode` binaries and documents running a local HTTP server and copying a Node project into app-private storage. However, the documented Android distribution is Node 18.20.4, while this project declares Node >=20. The current native `better-sqlite3` addon must be built and validated against the exact mobile runtime/ABI; desktop prebuilds cannot be assumed to work on Android.

This path is preferred only if a CI proof demonstrates:
1. arm64-v8a runtime starts on supported Android API levels;
2. Express serves the actual `/mobile` UI and all static assets from app-private storage;
3. the complete existing SQL schema initializes and migrations run;
4. the complete SQLite API used by the project passes database and integration tests on Android;
5. data survives process termination and device restart;
6. the full sales/purchases/returns/accounting/sync suites pass against the Android database driver.

### B. Replace the Android database driver with a compatible implementation

If `better-sqlite3` cannot be built reliably for the embedded runtime, evaluate a synchronous SQLite-compatible adapter backed by SQLite/WASM or a dedicated Android native SQLite bridge. The adapter must preserve the database contract used by all existing business modules. A superficial subset of SQL support is not acceptable. Every query, transaction, migration, pragma dependency, result shape, and error path must be tested.

A driver change must not silently fork financial/business logic between desktop and Android.

## Proof-of-concept gate (before full APK implementation)

- Build a small Android app containing the selected Node runtime for arm64-v8a.
- Start a local loopback Express health endpoint from app-private files.
- Create, commit, close, reopen, and verify a SQLite database using the proposed Android driver.
- Exercise prepared statements, positional/named bindings, transactions, rollback, row counts, last insert IDs, foreign keys, and the schema migration path.
- Run a representative end-to-end purchase -> FIFO stock layer -> sale -> partial return -> accounting/report calculation.
- Verify app restart persistence and offline operation with airplane mode enabled.
- Record runtime, SQLite engine/driver, ABI, Android API, APK size, and CI logs.

If the selected driver fails any gate, stop and evaluate the alternative before building the full APK. Do not publish a misleading APK artifact.

## Windows EXE and LAN host acceptance

The Windows installer must:
- package the actual Node/Express backend, frontend assets, and native SQLite dependency;
- use an application-data directory for the authoritative database and preserve it across upgrades;
- provide first-run owner setup without exposing reusable bootstrap secrets;
- support backup/restore and graceful shutdown;
- offer an explicit LAN-host mode bound to the local network only, with TLS certificate provisioning/trust instructions and firewall guidance;
- be tested with one Windows host and at least one Android client on a router/Wi-Fi network with WAN disconnected.

The current loopback-only Electron shell is a desktop preview, not proof of LAN hosting.

## Release gates

A temporary RC is distributable only after:
- clean install and first-run setup;
- no legacy database import or test-data carryover;
- all automated checks and tests pass;
- end-to-end financial and inventory regression tests pass;
- offline/restart/reconnect tests pass;
- Android-to-Windows LAN tests pass;
- no TLS bypass or insecure plain-HTTP LAN fallback;
- clear known-limitations and backup/restore instructions are included.

Production signing, signing keys, auto-update, and production rollout remain separate release work. This branch must not be merged into `main` until the acceptance gates are reviewed and explicitly approved.
