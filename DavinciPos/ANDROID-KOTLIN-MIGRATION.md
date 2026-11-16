# Android Kotlin + SQLite Migration

Status: architecture approved; staged implementation.
Branch: `feature/davincipos-android-kotlin-sqlite`
Baseline: `14b0775c2b8660235d684f601f54c16d18f09511`

## Accepted architecture

Keep the existing mobile HTML/CSS/JavaScript presentation. Android will ultimately use a Kotlin application/service layer and Android's platform SQLite engine. Node.js, Express and better-sqlite3 remain available to the Windows/LAN host; they will not be required by the final Android runtime.

## Compatibility constraint

The current UI calls an authenticated HTTP API and the business rules live in server-side JavaScript modules. Merely displaying the WebView or creating an empty SQLite database is not a functional POS. The Android replacement must preserve route contracts, authorization, transaction boundaries, integer minor-unit money, FIFO cost-layer allocation and return-cost restoration.

Do not switch the launcher away from the current runtime until the local Kotlin service layer covers all required routes and parity tests pass.

## API surface inventory

The current server exposes these routes (dynamic path parameters shown as `:id`, `:code`, `:role`, `:productId`, `:operationId`):

- Health/auth: GET /api/health; POST /api/auth/bootstrap; POST /api/auth/login; POST /api/auth/logout; GET /api/auth/me
- Devices/settings/users/roles: POST /api/devices/register; GET/PUT /api/settings; GET/POST /api/users; PATCH /api/users/:id; GET /api/roles; PUT /api/roles/:role/permissions
- Offline sync: POST /api/sync/offline-sales; GET /api/sync/offline-sales/:operationId/status; GET /api/sync/conflicts; POST /api/sync/conflicts/:id/resolve
- Tax/catalog: GET/POST /api/tax-profiles; GET/POST /api/products; PATCH /api/products/:id; GET/POST /api/units; GET/POST /api/products/:id/units; GET /api/barcode/:code; GET/POST /api/services; PATCH /api/services/:id; GET/PUT /api/services/:id/components; GET/POST /api/categories
- Currency: GET/POST /api/currency/rates; PUT /api/products/:id/currency
- People/settlements: GET/POST /api/customers; GET/POST /api/suppliers; GET /api/settlements/customers; GET /api/settlements/suppliers; GET /api/customers/:id/statement; GET /api/suppliers/:id/statement
- Sales/purchases/payments: GET /api/sales; GET /api/purchases; POST /api/sales/:id/payments; POST /api/purchases/:id/payments; POST /api/sales/quote; POST /api/sales/checkout; POST /api/purchases/quote; POST /api/purchases/receive
- Inventory: GET/POST /api/inventory/counts; GET /api/inventory/counts/:id; PUT /api/inventory/counts/:id/lines/:productId; POST /api/inventory/counts/:id/post; POST /api/inventory/adjustments
- Returns: GET /api/returns/sales/:id/options; POST /api/returns/sales/:id; GET /api/returns/purchases/:id/options; POST /api/returns/purchases/:id
- Accounting/reports/expenses: POST /api/accounting/journal-entries/:id/reverse; GET /api/accounting/trial-balance; GET/POST /api/expenses; GET /api/reports/simple; GET /api/reports/available; GET /api/reports/detail; GET /api/summary

## Staged work

1. Inventory the API and schema (this commit records the route contract).
2. Add the Kotlin SQLite foundation and package the existing web assets for Android.
3. Port authentication and read-only catalog operations, then transactional write operations.
4. Port FIFO/weighted inventory, returns, payments, accounting and reports with regression comparisons.
5. Add a typed WebView-to-Kotlin adapter and explicit LAN-host mode.
6. Switch Android startup only after feature parity and tests.
7. Build and test supported ABIs/devices. ARM 32-bit support is a separate compatibility target and must be proven by CI/device tests, not assumed.

## Release gate

Test fresh install/bootstrap, login/permissions, catalog and units, sales and payments, purchases, FIFO/weighted cost, partial/full returns, returned cost layers, expenses, balanced journals, net profit/COGS, currency-rate changes, offline persistence, process death/restart, duplicate sync replay, LAN reconnect and operation with WAN disconnected.

The current Node-based APK is still the reference runtime. This foundation commit does not claim that Android has been migrated or that a new APK is ready.


## Implementation update

The first CI build of this branch completed successfully (run 43769172667), including the existing Android packaging/alignment checks and the existing Windows test/package job. This is only a build check: the Android launcher still uses embedded Node.js, so this APK is not the Kotlin runtime.

The Kotlin foundation now includes:
- a platform `SQLiteOpenHelper` using the canonical packaged `schema.sql`;
- foreign-key enforcement and WAL configuration;
- initial branch, units, accounting accounts, settings, and role-permission seeds;
- a typed catalog repository for listing units/categories/products and transactionally creating categories/products;
- product stock and inventory value projections matching the current catalog read model.

Still intentionally not implemented:
- Android authentication/session parity (the current server uses Node scrypt; do not replace it with a weaker hash);
- the full HTTP API adapter used by the existing Web UI;
- product update, customer/supplier, purchases, sales, FIFO layers, returns, accounting, reports and sync services;
- launcher switch and Node/JNI removal.

The repository methods are a foundation only. They are not yet wired to WebView and do not make the Android application functionally independent. CI must compile this code before expanding the service surface.
