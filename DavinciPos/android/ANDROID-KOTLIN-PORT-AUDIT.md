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
| GET /api/settings | DavinciSettingsRepository + DavinciLocalApiFacade | Kotlin local facade + authenticated WebView bridge wired for local mode |
| PUT /api/settings | DavinciSettingsRepository + DavinciLocalApiFacade | Kotlin local facade implemented; WebView bridge not wired |
| GET /api/users | user administration repository | Not ported |
| POST /api/users | DavinciAuthRepository | Foundation only; API validation/response not matched |
| PATCH /api/users/:id | user administration repository | Not ported |
| PUT /api/roles/:role/permissions | role administration repository | Not ported |
| GET /api/roles | role administration repository | Not ported |
| POST /api/sync/offline-sales | Windows sync endpoint; Android outbox producer | Foundation only |
| GET /api/sync/offline-sales/:operationId/status | LAN sync client + status facade | Foundation only |
| GET /api/sync/conflicts | sync conflict repository | Foundation only |
| POST /api/sync/conflicts/:id/resolve | sync conflict repository | Foundation only |
| GET /api/tax-profiles | DavinciSettingsRepository + DavinciLocalApiFacade | Kotlin local facade implemented; WebView bridge not wired |
| POST /api/tax-profiles | DavinciSettingsRepository + DavinciLocalApiFacade | Kotlin local facade implemented; WebView bridge not wired |
| GET /api/products | DavinciCatalogRepository + local facade/bridge | Kotlin local route wired; response mapped |
| POST /api/products | DavinciCatalogRepository + local facade/bridge | Kotlin local route wired; update route remains open |
| PATCH /api/products/:id | DavinciCatalogRepository + local facade/bridge | Kotlin local route wired; partial update validation ported |
| GET /api/units | DavinciCatalogRepository + local facade/bridge | Kotlin local route wired |
| POST /api/units | DavinciCatalogRepository + local facade/bridge | Kotlin local route wired |
| GET /api/products/:id/units | DavinciCatalogRepository + local facade/bridge | Kotlin local route wired |
| POST /api/products/:id/units | DavinciCatalogRepository + local facade/bridge | Kotlin local route wired |
| GET /api/barcode/:code | DavinciCatalogRepository + local facade/bridge | Kotlin local route wired |
| GET /api/services | DavinciServiceRepository + DavinciLocalApiFacade | Kotlin local facade implemented; WebView bridge not wired |
| POST /api/services | DavinciServiceRepository + DavinciLocalApiFacade | Kotlin local facade implemented; WebView bridge not wired |
| PATCH /api/services/:id | DavinciServiceRepository + DavinciLocalApiFacade | Kotlin local facade implemented; WebView bridge not wired |
| GET /api/services/:id/components | DavinciServiceRepository + DavinciLocalApiFacade | Kotlin local facade implemented; WebView bridge not wired |
| PUT /api/services/:id/components | DavinciServiceRepository + DavinciLocalApiFacade | Kotlin local facade implemented; WebView bridge not wired |
| GET /api/currency/rates | DavinciCurrencyRepository + local facade/bridge | Kotlin local route wired |
| POST /api/currency/rates | DavinciCurrencyRepository + local facade/bridge | Kotlin local route wired |
| PUT /api/products/:id/currency | DavinciCurrencyRepository + local facade/bridge | Kotlin local route wired |
| GET /api/categories | DavinciCatalogRepository + local facade/bridge | Kotlin local route wired |
| POST /api/categories | DavinciCatalogRepository + local facade/bridge | Kotlin local route wired |
| GET /api/customers | DavinciPeopleRepository + local facade/bridge | Kotlin local route wired |
| POST /api/customers | DavinciPeopleRepository + local facade/bridge | Kotlin local route wired |
| GET /api/suppliers | DavinciPeopleRepository + local facade/bridge | Kotlin local route wired |
| POST /api/suppliers | DavinciPeopleRepository + local facade/bridge | Kotlin local route wired |
| GET /api/settlements/customers | DavinciSettlementRepository + local facade/bridge | Kotlin local route wired |
| GET /api/settlements/suppliers | DavinciSettlementRepository + local facade/bridge | Kotlin local route wired |
| GET /api/customers/:id/statement | DavinciSettlementRepository + local facade/bridge | Kotlin local route wired |
| GET /api/suppliers/:id/statement | DavinciSettlementRepository + local facade/bridge | Kotlin local route wired |
| POST /api/sales/:id/payments | DavinciSettlementRepository + local facade/bridge | Kotlin local route wired; idempotency required |
| POST /api/purchases/:id/payments | DavinciSettlementRepository + local facade/bridge | Kotlin local route wired; idempotency required |
| GET /api/sales | DavinciDocumentRepository + local facade/bridge | Kotlin local route wired; read-only invoice history |
| GET /api/purchases | DavinciDocumentRepository + local facade/bridge | Kotlin local route wired; read-only invoice history |
| GET /api/inventory/counts | DavinciInventoryWorkflowRepository + local facade/bridge | Kotlin local route wired |
| POST /api/inventory/counts | DavinciInventoryWorkflowRepository + local facade/bridge | Kotlin local route wired |
| GET /api/inventory/counts/:id | DavinciInventoryWorkflowRepository + local facade/bridge | Kotlin local route wired |
| PUT /api/inventory/counts/:id/lines/:productId | DavinciInventoryWorkflowRepository + local facade/bridge | Kotlin local route wired |
| POST /api/inventory/counts/:id/post | DavinciInventoryWorkflowRepository + accounting + local facade/bridge | Kotlin local route wired |
| POST /api/inventory/adjustments | DavinciInventoryWorkflowRepository + accounting + local facade/bridge | Kotlin local route wired |
| POST /api/sales/quote | sales pricing/tax/FIFO service | Not ported |
| POST /api/sales/checkout | sales + payments + accounting + FIFO service | Not ported |
| POST /api/purchases/quote | DavinciPurchaseRepository + local facade/bridge | Kotlin local route wired |
| GET /api/returns/sales/:id/options | sales-return repository | Not ported |
| POST /api/returns/sales/:id | sales-return + FIFO cost reversal + accounting service | Not ported |
| GET /api/returns/purchases/:id/options | purchase-return repository | Not ported |
| POST /api/returns/purchases/:id | purchase-return + inventory + accounting service | Not ported |
| POST /api/purchases/receive | DavinciPurchaseRepository + inventory + accounting + local facade/bridge | Kotlin local route wired |
| POST /api/accounting/journal-entries/:id/reverse | DavinciAccountingRepository.reverseJournalEntry | Foundation implemented; DB integration tests still required |
| GET /api/accounting/trial-balance | DavinciAccountingRepository.getTrialBalance | Foundation implemented with inclusive from/exclusive next-day to filters; DB integration/parity tests still required |
| GET /api/accounting/ledger/:accountId | DavinciAccountingRepository.getAccountLedger | Foundation implemented; DB integration and route response parity still required |\n| GET /api/expenses | DavinciExpenseRepository + local facade/bridge | Kotlin local route wired |
| POST /api/expenses | DavinciExpenseRepository + accounting + local facade/bridge | Kotlin local route wired |
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

## Accounting slice added after the initial audit\n\n- `DavinciAccountingRepository.kt` now provides balanced journal posting with source idempotency, active-account validation, atomic draft-to-post transition, reversal entries, and trial-balance aggregation.\n- `DavinciJournalValidatorTest.kt` covers balanced multi-line entries, imbalance, zero/both-sided lines, blank account IDs, single-line entries, and safe-integer overflow.\n- Added trial-balance date filtering with strict calendar-date validation and an account-ledger query matching the Node SQL ordering and optional timestamp bounds. Added unit tests for date boundaries and invalid dates.\n- Added Robolectric SQLite integration coverage for posting, source idempotency, rejection of unbalanced journals, reversal idempotency, reversal status linkage, date-filtered trial balance, account ledger, and immutable posted journal lines. CI execution is pending.
- Remaining before accounting parity: ledger response/route parity; then wire accounting into sale, purchase, payment, returns and expense workflows.\n\n## Known correctness check completed during this audit

The Node scrypt text-salt compatibility vector was independently recalculated with Node's `crypto.scryptSync`. The expected value in `DavinciScryptTest.matchesNodeHexTextSaltEncoding` matches Node exactly:
`fe1559ad60e4066f60b60896ee0fb5d61fe7722a3a6e095dec5022c958d79b4d5faf1e7bc0a42f3fc74306c88bec2460f8fd052cf0ec75de912719a206285c7c`.

This verifies that one critical hash-encoding test vector is correct; it does not establish that the Android authentication repository is fully integrated or that the complete Android port is ready.

## Kotlin-native service/settings slice added

- Added `DavinciServiceRepository.kt`: service create/update/activation, component BOM replacement, stock-tracked component validation, component cost/sale summaries, and atomic service-plus-components save.
- Added `DavinciSettingsRepository.kt`: settings read/update with the same allowed keys and normalization rules as `settings.js`, inventory-cost-method lock after stock activity, audit rows, tax-profile CRUD/default selection and resolution.
- Added `DavinciLocalApiFacade.kt`: API-compatible dispatch for service, component, settings and tax-profile routes.
- Added `DavinciWebViewBridge.kt` and wired it into local-mode `MainActivity`: local WebView fetch calls for these explicitly supported routes are authenticated against the shared SQLite session and checked against role permissions, then dispatched to Kotlin. Unsupported routes continue to use the existing Node server; remote LAN mode continues to use the Windows HTTPS server.
- These routes are now wired end-to-end for the selected operations, but the Android runtime is **not Node-free**. Bootstrap/login, products, inventory, sales, purchases, returns, settlements, reports and other unsupported operations still depend on Node. Do not remove Node/JNI until the full route matrix and offline/LAN gates are complete.


## Kotlin-native settlements slice added

- Added `DavinciSettlementRepository.kt`: customer invoice collections, supplier invoice payments, customer/supplier balances and statements, remaining-balance checks after returns, wallet-provider validation, accounting postings to AR/AP and cash/bank/card/wallet accounts, optional audit records, and idempotent replay using the shared `payment_idempotency` table.
- Added API facade and authenticated WebView bridge routes for settlement balances, statements, and payment collection/disbursement. The bridge forwards the `Idempotency-Key` header and also accepts the existing UI body key.
- Fixed the shared people screen: it now generates a stable idempotency key per payment payload and reuses it on retry, rotating it only when payment details change. Previously the UI omitted the key although the server required it, so customer and supplier payment forms could never successfully post.
- These routes still run against the shared SQLite database in local Android mode; they do not remove Node.js, which remains responsible for all routes not yet migrated.

- Customer and supplier directory read/create routes are now also wired through the authenticated Kotlin bridge; people screens can create records and use the native settlement routes without these operations falling back to Node.

- Product catalogue read/create, categories, units, product-unit conversions and barcode lookup are now dispatched to Kotlin in local Android mode. Product PATCH, product-currency updates and the remaining catalog edge cases are still unported.

- USD/SDG exchange-rate history, current-rate lookup, optional automatic recalculation of linked USD product prices, and product currency configuration are now exposed through the authenticated local Kotlin bridge.

- Product PATCH now enforces the Node-side invariants for base-unit changes after stock movements, disabling stock tracking with positive stock, safe monetary values, tax rate bounds and minimum stock; it is exposed through the authenticated Kotlin bridge.

- Android Kotlin now owns inventory adjustment workflows and physical count lifecycle (create, fetch, line entry, atomic posting), including stock layer changes, accounting gains/losses, duplicate adjustment IDs and audit rows. These endpoints are wired in local WebView mode.

- Expense entry and history are now Kotlin-native in local Android mode, including payment-method/provider validation, integer minor-unit accounting, balanced expense-vs-cash/bank/card/wallet postings, and audit trail.

- Sales and purchase invoice history lists now read directly from the Android SQLite database through Kotlin; invoice return actions and full purchase/sale workflows remain separate route work.

- Purchase quote and receipt now have Kotlin implementations: product/unit validation, tax-profile and purchase-tax treatment, recoverable/non-recoverable tax handling, split/partial payments, inventory layer receipt, purchase variance, AP, input-tax and payment-account journals. The local Android UI routes for purchase quoting and receiving are bridged to Kotlin.


## Kotlin-native return workflows added from ERPNext return-document model

- Added `DavinciReturnRepository.kt` with source-linked sales and supplier purchase return options and posting routes. Returns reference original invoice lines, calculate remaining eligible quantities from prior return documents, reject duplicate/over-returns, and post the return header, detail rows, inventory movement, refund/payment record, journal entry and audit row in one transaction.
- Sales returns restore the exact consumed FIFO source layers using `sale_line_cost_layers` and `inventory_layer_id`; when no layer allocation exists (weighted-cost sale), they restore stock at the original sale line unit cost. Customer refund is capped at collected payments; the remainder reduces receivables.
- Purchase returns issue stock using the configured inventory valuation method, cap supplier refunds at net cash paid, reduce payables for the balance, reverse recoverable input tax, and reconcile the difference between purchase value and removed inventory value through purchase variance.
- Wired `GET/POST /api/returns/sales/:id[/options]` and `GET/POST /api/returns/purchases/:id[/options]` into the authenticated Kotlin WebView bridge with `sales.return` and `purchases.return` permissions. Response shapes match the existing returns screen.
- This is a first Kotlin port of the current Node return workflow. It does not yet implement a separate physical return receipt vs credit-note-only mode, serial/batch traceability, return cancellation, or full source-document status/statement/report reconciliation; those remain explicit parity gaps.
