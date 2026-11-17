# Android Standalone / Client Architecture

## Decision

Android supports two explicit operating modes:

- `standalone`: the phone owns its business data and executes POS operations locally. No Windows host, Node.js process, LAN connection, or internet connection is required for normal operations.
- `client`: the phone connects to a Windows Server over LAN/Wi-Fi, keeps a durable local replica and outbox, and synchronizes queued operations when connectivity returns.

Windows remains `server` or `client`. Android must never expose a server role.

## Current implementation findings (before migration)

The current React application uses Dexie/IndexedDB (`src/db/db.ts`) for its browser-side tables and local offline cache. The SQLite/Drizzle database (`drizzle/db.ts`) is opened by the Node.js Express backend. The current Capacitor onboarding forces Android to `client`, and `App.tsx` also overwrites the Android role to `client`. Business operations such as sale, returns, purchases, stock consumption, FIFO valuation, and journal posting are implemented in the server-side transactional engine (`server/operations.ts` and `server/accounting.ts`).

Therefore, merely changing the Android role selector or setting API_BASE to a local URL would not produce a true standalone Android POS. It would leave critical operations dependent on Express/Node. This migration must be completed before standalone mode is enabled in a release build.

## Target architecture

### Local persistence

- Android: native SQLite database owned by the app's private storage, accessed through a Kotlin Capacitor plugin. Use explicit schema versioning and transactional migrations.
- Windows: retain the existing SQLite/Drizzle server database.
- React screens must use a platform-neutral repository/API boundary; they must not know whether persistence is Android SQLite, Windows SQLite API, or remote LAN API.
- Preserve stable UUID operation IDs and device IDs. Never use local auto-increment IDs as cross-device identity.

### Business operations

Move the business rules into a platform-neutral, deterministic domain layer, or provide a verified Kotlin implementation with shared contract fixtures. At minimum, the same rules must apply on both platforms for:
- checkout and tax/discount calculations;
- stock availability and stock policy;
- FIFO inventory consumption/restoration and weighted-average costing;
- returns, voids, purchases, purchase returns and payments;
- shifts, expenses, customer/supplier balances;
- double-entry journal posting and fiscal-period restrictions;
- audit records and idempotency.

Each mutation must be atomic with its related stock, accounting, audit and outbox changes. Replaying an operation ID must return the prior result and must never apply it twice.

### Synchronization

The client outbox must be durable and ordered. Each operation carries operationId, deviceId, tenant/store identity, branchId, actor, schema version, creation time and payload. Server acknowledgements transition queued operations to synced; retryable failures remain queued with backoff; validation/accounting conflicts are surfaced for review and are never silently discarded.

On a LAN outage, client mode remains client mode and records supported operations locally. It does not silently become a second independent master. Standalone mode is a separate explicit store database.

### First-time pairing / data transfer

When a standalone Android device is paired to a Windows server, present two reviewed workflows:
1. Import selected standalone store data into the server (with conflict preview, ID remapping, totals/reconciliation and backup).
2. Replace the phone's working dataset with a server snapshot (after backup and explicit confirmation).

Never merge by blindly copying integer primary keys. Use stable UUIDs and explicit conflict policies. Keep the source backup until reconciliation is accepted.

## Delivery phases and release gates

1. **Inventory and contracts:** map every Dexie table, API method, operation type, server transaction, auth path and screen dependency. Define schema/domain contracts and migration plan.
2. **Android native SQLite foundation:** add Kotlin/Capacitor persistence plugin, schema migrations, encrypted/secure credential handling where supported, backup/restore, and repository tests.
3. **Local domain engine:** implement and verify atomic local business operations against the Windows engine using shared fixtures. Do not enable standalone selection until critical operations pass.
4. **Repository integration:** route Android standalone reads/writes to native persistence and local domain engine; preserve current React screens and behavior. Keep Windows server/client behavior intact.
5. **Client outbox and sync:** make offline client writes durable and idempotent; add reconnect/retry/conflict handling and LAN-only connectivity tests.
6. **Pairing and transfer:** implement both reviewed transfer directions with backup, preview, reconciliation and rollback.
7. **Packaging:** produce two byte-identical Android APK deliverables and one Windows x64 EXE from this branch. Android minimum SDK 26 (Android 8); Windows target remains Electron 22 / Windows 7 x64 compatibility subject to actual OS testing.
8. **Release validation:** clean install, upgrade, offline standalone, offline client, reconnect, duplicate replay, data transfer, database migration, and Windows Server/Client tests. No release is described as complete until the actual artifacts and test evidence are available.

## Non-negotiable safeguards

- Do not modify `main`, merge this branch, or create a PR as part of this work.
- Do not remove Dexie or the existing Windows server engine until replacement coverage is complete.
- Do not expose a nonfunctional standalone option.
- Do not claim Android standalone is complete merely because an APK builds.
- The two Android APK files must be copied from the same build output and verified with matching SHA-256 hashes.

## Implementation progress

- Added `native/android/PosLocalDatabasePlugin.kt`: a Kotlin Capacitor plugin backed by app-private SQLite. It provides record persistence, metadata, a durable operation outbox, idempotent operation IDs, ordered pending-operation reads, acknowledgements and retry-error state. The outbox envelope now includes device, tenant/store, branch, actor and schema-version metadata; database schema version 2 migrates existing version-1 outboxes additively.
- Added `native/android/MainActivity.kt` to register the plugin, and `src/native/posLocalDatabase.ts` as its typed React/TypeScript bridge.
- Updated the Android packaging workflow to copy and register the native sources after Capacitor generates the Android project.

- Added `saveRecordAndEnqueueOperation` to the Kotlin plugin and typed bridge. It commits one local record and its outbox envelope in a single SQLite transaction, and resolves the call only after commit. This is a safe primitive, not yet connected to POS screens or a complete multi-table accounting/inventory transaction.
- This is persistence infrastructure only. The React repositories, authentication, business-operation engine, and sync service are not yet routed through this database. Android standalone mode must remain unavailable until those integrations are complete. The existing Dexie database is still the active application store.
- Requested functional tests are intentionally deferred until implementation and all three package builds are complete. Compilation/build feedback may still be used to fix packaging blockers; no functional test campaign is being run in this phase.
