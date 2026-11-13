# DavinciPos

DavinciPos is a clean rebuild of the legacy POS application. The legacy application remains untouched.

## Flat project layout

Every authored project file is placed directly in this directory. There are no nested source folders.

- `desktop.html` / `desktop.css` / `desktop.js`: desktop-first interface.
- `mobile.html` / `mobile.css` / `mobile.js`: independent mobile interface.
- `server.js`: HTTP API and application bootstrap.
- `database.js` / `schema.sql`: SQLite persistence and schema.
- `sales.js`, `purchases.js`, `inventory.js`, `tax.js`, `accounting.js`: shared business rules.
- `sync.js` / `offline.js`: local outbox primitives, idempotent server reconciliation, and stock-conflict review.
- `security.js`: password hashing, expiring sessions, role permissions and account management.
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

Amounts are stored as integer minor units (for example, cents/piasters) to avoid floating-point accounting errors. Every posted journal entry must balance. Posted financial records are corrected by reversal, not destructive deletion.

## Accounting and stock foundation

- Inventory receipts create cost layers. Issues can use weighted average or FIFO.
- The active costing method is selected before stock activity; changing it after movements exist is blocked until a controlled revaluation workflow is implemented.
- Sales and purchase receipts are executed in SQLite transactions and generate journal entries.
- Sales tax can be enabled/disabled centrally, calculated inclusive or exclusive, and assigned reusable default tax profiles.
- Purchase tax can be disabled, treated as recoverable input tax, or capitalized into inventory cost.
- All APIs require authenticated sessions and server-enforced permissions; network binding requires HTTPS/TLS.
- Purchase tax is configurable centrally: disabled, recoverable input tax, or non-recoverable tax capitalized into inventory cost.
- Posted journal entries are balanced, protected against line edits/deletion, and corrected through reversing entries.
- `npm test` runs focused accounting, inventory, tax and purchase-to-sale integration tests. `npm run check` runs JavaScript syntax checks.
