# DavinciPos

DavinciPos is a clean rebuild of the legacy POS application. The legacy application remains untouched.

## Flat project layout

Every authored project file is placed directly in this directory. There are no nested source folders.

- `desktop.html` / `desktop.css` / `desktop.js`: desktop-first interface.
- `mobile.html` / `mobile.css` / `mobile.js`: independent mobile interface.
- `server.js`: HTTP API and application bootstrap.
- `database.js` / `schema.sql`: SQLite persistence and schema.
- `sales.js`, `purchases.js`, `inventory.js`, `tax.js`, `accounting.js`: shared business rules; accounting remains internal and is not exposed as an everyday workflow.
- `reports.js`: date-filtered detailed reports for daily sales, sales invoices/products/categories/customers/payment methods, purchase invoices/products/categories/payment methods, stock balances and movements, tax summary, and cash receipts/payments. The simplified summary remains available as well.
- `sync.js` / `offline.js`: outbox primitives, idempotent server reconciliation, and stock-conflict review. The client-side durable SQLite outbox adapters are still pending.
- `security.js`: password hashing, expiring sessions, role permissions and account management.
- `catalog.js`: products, alternate sales units and conversion factors, barcode lookup, service catalog and service material recipes, categories, customers and suppliers.
- `currency.js`: USD/SDG exchange-rate history and optional automatic repricing for products whose source prices are maintained in USD.
- Inventory supports draft physical stock counts, barcode-based counting, and posting stock differences through audited adjustments.
- The desktop and mobile interfaces include product management, stock adjustments, customer/supplier records, server-quoted sales checkout, purchase receiving, selectable detailed store reports, central settings, user roles and sync conflict review. Wallet payments can be distinguished as Bankak, OCash, Fawry or MyCashy while retaining a common wallet clearing account.
- `settings.js`: server-owned settings with validation and audit history.
- `client.js`: shared authenticated API and settings/user administration UI.

## Run

Requires Node.js 20 or newer.

```sh
cd DavinciPos
npm install
npm start
```

Before first startup, set a one-time `DAVINCIPOS_BOOTSTRAP_TOKEN` environment variable. Open `http://localhost:3000/desktop`; the first screen creates the owner account using that token. Example: `DAVINCIPOS_BOOTSTRAP_TOKEN='a-long-random-secret' npm start`. The bootstrap token is not stored in the database. Subsequent logins use the owner-created account. For LAN deployment, set `HOST=0.0.0.0`, `TLS_CERT_PATH`, and `TLS_KEY_PATH`; the server refuses LAN binding without TLS. The server binds to `127.0.0.1` by default. LAN access requires TLS certificate/key configuration plus authenticated sessions and role permissions. Never expose the server over plain HTTP on a network.

## Architecture decisions

The server-side SQLite database is the authoritative store. Business rules are shared by both interfaces. The desktop and mobile interfaces are intentionally separate presentations.

The current milestone provides server-side offline-sale reconciliation and conflict handling, but does not yet include the finished local SQLite adapters or a complete offline-capable client UI. Electron will use a native SQLite adapter, and Android Capacitor will use a Capacitor SQLite adapter. Both adapters must implement the same repository contract and durable outbox before true device-side offline operation is enabled.

The app is designed for shop owners and everyday staff, not accountants. Users work with familiar screens for sales, purchases, stock, expenses and simple reports; journal entries and double-entry checks remain internal implementation details only. Users are not expected to understand ledgers, debit/credit columns or journal numbers. Amounts are stored as integer minor units to keep totals accurate.

## Accounting and stock foundation

- Inventory receipts create cost layers. Issues can use weighted average or FIFO.
- The active costing method is selected before stock activity; changing it after movements exist is blocked until a controlled revaluation workflow is implemented.
- Sales and purchase receipts are executed in SQLite transactions and generate journal entries.
- Sales tax can be enabled/disabled centrally, calculated inclusive or exclusive, and assigned reusable default tax profiles.
- Purchase tax can be disabled, treated as recoverable input tax, or capitalized into inventory cost. Each invoice and line stores the applied tax mode, profile ID and rate snapshot for historical accuracy.
- Roles include owner, admin, manager, cashier, sales and accountant. Permissions are checked on the server and can be edited per role by an authorized administrator.
- Central settings are stored on the server and are read by all connected clients. Settings changes are audited.
- All APIs require authenticated sessions and server-enforced permissions; network binding requires HTTPS/TLS.
- Posted journal entries are balanced, protected against line edits/deletion, and corrected through reversing entries.
- `npm test` runs accounting, inventory, tax, offline conflict, catalog and purchase-to-sale tests. `npm run check` runs JavaScript syntax checks.
