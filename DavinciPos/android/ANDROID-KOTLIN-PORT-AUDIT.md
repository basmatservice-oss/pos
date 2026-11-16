# Android Kotlin Port — API Parity Audit

**Branch:** `develop`  
**Audit baseline:** `c683b55946bfa53ea12419714c69b2eec0691f5a`  
**Purpose:** prevent switching the Android launcher away from Node.js before every mobile-facing operation has a Kotlin implementation and parity tests.

## Executive status

The Android tree currently contains Kotlin foundations for database/schema initialization, authentication, catalog reads/writes, people, currency, inventory primitives, FIFO/weighted allocation, tax calculation, journal posting/reversal/trial-balance foundations, LAN HTTP validation, and offline-sync/outbox primitives.

This is **not** a complete Android port. The current `MainActivity.java` still loads `libnode` and `libdavincipos-native` for local mode, starts the embedded Node server, and loads `/mobile`. The Android Gradle build still configures CMake and `node-host.cpp`. The Kotlin repositories are not exposed through a complete WebView bridge. No launcher/runtime removal is authorized by this audit.

## Route-by-route coverage

Status meanings:
- **Foundation only:** related Kotlin primitives exist, but the complete route behavior/response contract is not implemented.
- **Not ported:** no complete Kotlin route-equivalent service is present.
- **Server-only:** intentionally remains on the Windows Node/Express server; Android must call it through the LAN client when online.
- **Gate:** must have parity tests before it can be marked complete.

| Node route | Kotlin target | Status |
|---|---|---|
| GET /api/health | Android runtime health facade | Not ported |
| POST /api/auth/bootstrap | DavinciAuthRepository + bootstrap facade | Foundation only; bootstrap response/one-time policy not fully matched |
| POST /api/auth/login | DavinciAuthRepository | Foundation only; response/permissions and bridge not wired |
| POST /api/auth/logout | DavinciAuthRepository | Foundation only; bridge not wired |
| GET /api/auth/me | DavinciAuthRepository | Foundation only; bridge not wired |
| POST /api/devices/register | device repository + sync identity | Not ported |
| GET /api/settings | settings repository | Not ported |
| PUT /api/settings | settings repository | Not ported |
| GET /api/users | user administration repository | Not ported |
| POST /api/users | DavinciAuthRepository | Foundation only; API validation/response not matched |
| PATCH /api/users/:id | user administration repository | Not ported |
| PUT /api/roles/:role/permissions | role administration repository | Not ported |
| GET /api/roles | role administration repository | Not ported |
| POST /api/sync/offline-sales | Windows sync endpoint; Android outbox producer | Foundation only |
| GET /api/sync/offline-sales/:operationId/status | LAN sync client + status facade | Foundation only |
| GET /api/sync/conflicts | sync conflict repository | Foundation only |
| POST /api/sync/conflicts/:id/resolve | sync conflict repository | Foundation only |
| GET /api/tax-profiles | tax-profile repository | Not ported |
| POST /api/tax-profiles | tax-profile repository | Not ported |
| GET /api/products | DavinciCatalogRepository | Foundation only; verify full response/filter parity |
| POST /api/products | DavinciCatalogRepository | Foundation only; verify validation/audit parity |
| PATCH /api/products/:id | DavinciCatalogRepository | Foundation only; verify validation/audit parity |
| GET /api/units | DavinciCatalogRepository | Foundation only |
| POST /api/units | DavinciCatalogRepository | Foundation only |
| GET /api/products/:id/units | DavinciCatalogRepository | Foundation only |
| POST /api/products/:id/units | DavinciCatalogRepository | Foundation only |
| GET /api/barcode/:code | DavinciCatalogRepository | Foundation only |
| GET /api/services | service/BOM repository | Not ported |
| POST /api/services | service/BOM repository | Not ported |
| PATCH /api/services/:id | service/BOM repository | Not ported |
| GET /api/services/:id/components | service/BOM repository | Not ported |
| PUT /api/services/:id/components | service/BOM repository | Not ported |
| GET /api/currency/rates | DavinciCurrencyRepository | Foundation only; verify date selection/response parity |
| POST /api/currency/rates | DavinciCurrencyRepository | Foundation only; verify rounding and historical-rate behavior |
| PUT /api/products/:id/currency | DavinciCurrencyRepository | Foundation only; verify price recalculation parity |
| GET /api/categories | DavinciCatalogRepository | Foundation only |
| POST /api/categories | DavinciCatalogRepository | Foundation only |
| GET /api/customers | DavinciPeopleRepository | Foundation only |
| POST /api/customers | DavinciPeopleRepository | Foundation only |
| GET /api/suppliers | DavinciPeopleRepository | Foundation only |
| POST /api/suppliers | DavinciPeopleRepository | Foundation only |
| GET /api/settlements/customers | customer balance/statement repository | Not ported |
| GET /api/settlements/suppliers | supplier balance/statement repository | Not ported |
| GET /api/customers/:id/statement | customer balance/statement repository | Not ported |
| GET /api/suppliers/:id/statement | supplier balance/statement repository | Not ported |
| POST /api/sales/:id/payments | sales + accounting transaction service | Not ported |
| POST /api/purchases/:id/payments | purchases + accounting transaction service | Not ported |
| GET /api/sales | sales repository | Not ported |
| GET /api/purchases | purchases repository | Not ported |
| GET /api/inventory/counts | stocktaking repository | Not ported |
| POST /api/inventory/counts | stocktaking repository | Not ported |
| GET /api/inventory/counts/:id | stocktaking repository | Not ported |
| PUT /api/inventory/counts/:id/lines/:productId | stocktaking repository | Not ported |
| POST /api/inventory/counts/:id/post | stocktaking + accounting transaction service | Not ported |
| POST /api/inventory/adjustments | inventory + accounting transaction service | Foundation only; low-level stock primitives are not the full workflow |
| POST /api/sales/quote | sales pricing/tax/FIFO service | Not ported |
| POST /api/sales/checkout | sales + payments + accounting + FIFO service | Not ported |
| POST /api/purchases/quote | purchase pricing/tax service | Not ported |
| GET /api/returns/sales/:id/options | sales-return repository | Not ported |
| POST /api/returns/sales/:id | sales-return + FIFO cost reversal + accounting service | Not ported |
| GET /api/returns/purchases/:id/options | purchase-return repository | Not ported |
| POST /api/returns/purchases/:id | purchase-return + inventory + accounting service | Not ported |
| POST /api/purchases/receive | purchase receiving + inventory/FIFO service | Not ported |
| POST /api/accounting/journal-entries/:id/reverse | DavinciAccountingRepository.reverseJournalEntry | Foundation implemented; DB integration tests still required |
| GET /api/accounting/trial-balance | DavinciAccountingRepository.getTrialBalance | Foundation implemented; date-filter parity and DB integration tests still required |
| GET /api/expenses | expense repository | Not ported |
| POST /api/expenses | expense + accounting transaction service | Not ported |
| GET /api/reports/simple | reporting repository | Not ported |
| GET /api/reports/available | reporting repository | Not ported |
| GET /api/reports/detail | reporting repository | Not ported |
| GET /api/summary | dashboard/reporting repository | Not ported |

Static UI routes (`/mobile`, `/desktop`, `/assets/*`, `/service-worker.js`) remain delivery concerns, not business-operation ports. The existing mobile UI can be retained, but every data operation it currently sends to `/api/*` needs an explicit routing decision: local Kotlin facade or remote Windows server.

## Required implementation layers

1. **Typed repositories:** complete database operations with transactions, validation, audit records, and canonical JSON-compatible DTOs.
2. **Application services:** orchestrate multi-table business workflows (sale, purchase, payment, return, accounting, inventory count). Do not compose these by calling repository methods that each open independent transactions.
3. **Compatibility facade:** expose a narrow `DavinciPos` JavaScript interface to WebView. Map existing API request/response shapes without exposing raw SQL or database handles.
4. **Transport router:** in local mode route supported operations to Kotlin; in LAN mode route requests to the Windows HTTPS API. Never silently fall back to an empty/local database when remote mode is selected.
5. **Parity fixtures:** run identical input fixtures against the Node implementation and Kotlin implementation; compare business fields and ledger/inventory effects, ignoring generated IDs/timestamps where appropriate.

## Release gates before removing Android Node.js

- Every route above is explicitly classified as Kotlin-local or Windows-server-only, with no unclassified API calls left in the mobile UI.
- Authentication: existing Node-created password hashes can log in on Android; bootstrap, roles, permissions, session expiry, logout, inactive users, and audit behavior match.
- Inventory: FIFO and weighted methods, stock layers, negative-stock rules, unit conversions, and branch scoping match.
- Sales/purchases: quote, checkout/receive, discounts, taxes (inclusive/exclusive), multiple payment methods, credit, and idempotency match.
- Returns: partial and full returns restore quantities and reverse the exact consumed FIFO cost layers; accounting entries match.
- Payments/settlements: customer and supplier balances, allocations, reversals, and statements match.
- Reports: revenue, net profit, COGS, returns, tax, cash/bank/wallet/card, expenses, trial balance, and date filters match.
- Offline: durable outbox, idempotency, conflict resolution, and reconnect/retry behavior pass; no duplicate posting.
- LAN: real HTTPS connection to Windows over Wi-Fi/LAN succeeds with the configured certificate trust; no internet dependency.
- WebView: all current screens work through the compatibility facade with no direct Node dependency.
- Only after these gates pass: remove Android Node runtime assets, JNI libraries, CMake target, `node-host.cpp`, and Node SQLite addon packaging. Windows Node/Express remains unchanged.

## Accounting slice added after the initial audit\n\n- `DavinciAccountingRepository.kt` now provides balanced journal posting with source idempotency, active-account validation, atomic draft-to-post transition, reversal entries, and trial-balance aggregation.\n- `DavinciJournalValidatorTest.kt` covers balanced multi-line entries, imbalance, zero/both-sided lines, blank account IDs, single-line entries, and safe-integer overflow.\n- Remaining before accounting parity: instrumented SQLite integration tests for schema triggers, source idempotency and reversal behavior; trial-balance date filters; ledger endpoint parity; then wire the service into sale, purchase, payment, returns and expense workflows.\n\n## Known correctness check completed during this audit

The Node scrypt text-salt compatibility vector was independently recalculated with Node's `crypto.scryptSync`. The expected value in `DavinciScryptTest.matchesNodeHexTextSaltEncoding` matches Node exactly:
`fe1559ad60e4066f60b60896ee0fb5d61fe7722a3a6e095dec5022c958d79b4d5faf1e7bc0a42f3fc74306c88bec2460f8fd052cf0ec75de912719a206285c7c`.

This verifies that one critical hash-encoding test vector is correct; it does not establish that the Android authentication repository is fully integrated or that the complete Android port is ready.
