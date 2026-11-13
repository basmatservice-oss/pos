# DavinciPos

DavinciPos is a clean rebuild of the legacy POS application. The legacy application remains untouched.

## Flat project layout

Every authored project file is placed directly in this directory. There are no nested source folders.

- `desktop.html` / `desktop.css` / `desktop.js`: desktop-first interface.
- `mobile.html` / `mobile.css` / `mobile.js`: independent mobile interface.
- `server.js`: HTTP API and application bootstrap.
- `database.js` / `schema.sql`: SQLite persistence and schema.
- `sales.js`, `purchases.js`, `inventory.js`, `tax.js`, `accounting.js`: shared business rules.
- `sync.js`: durable synchronization primitives and protocol.

## Run

Requires Node.js 20 or newer.

```sh
cd DavinciPos
npm install
npm start
```

Open `http://localhost:3000/desktop` for local development. The server binds to `127.0.0.1` by default. LAN access requires TLS certificate/key configuration plus authenticated sessions and role permissions. Never expose the server over plain HTTP on a network.

## Architecture decisions

The server-side SQLite database is the authoritative store. Business rules are shared by both interfaces. The desktop and mobile interfaces are intentionally separate presentations.

The first milestone establishes the schema, API boundary, and domain modules. It is not yet a production-ready offline client: Electron will use the native SQLite adapter, and the Android Capacitor build will use a Capacitor SQLite adapter. Both adapters must implement the same repository contract before offline operation is enabled on those platforms.

Amounts are stored as integer minor units (for example, cents/piasters) to avoid floating-point accounting errors. Every posted journal entry must balance. Posted financial records are corrected by reversal, not destructive deletion.

## Accounting and stock foundation

- Inventory receipts create cost layers. Issues can use weighted average or FIFO.
- The active costing method is selected before stock activity; changing it after movements exist is blocked until a controlled revaluation workflow is implemented.
- Sales and purchase receipts are executed in SQLite transactions and generate journal entries.
- Sales tax can be calculated inclusive or exclusive, with reusable tax profiles.
- Purchase tax is configurable centrally: disabled, recoverable input tax, or non-recoverable tax capitalized into inventory cost.
- Posted journal entries are balanced, protected against line edits/deletion, and corrected through reversing entries.
- `npm test` runs focused accounting, inventory, tax and purchase-to-sale integration tests. `npm run check` runs JavaScript syntax checks.
