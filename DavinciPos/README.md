# DavinciPos

DavinciPos is a clean rebuild of the legacy POS application. The legacy application remains untouched.

## Flat project layout

Every authored project file is placed directly in this directory. There are no nested source folders.

- `desktop.html` / `desktop.css` / `desktop.js`: desktop-first interface.
- `mobile.html` / `mobile.css` / `mobile.js`: independent mobile interface.
- `server.js`: HTTP API and application bootstrap.
- `database.js` / `schema.sql`: SQLite persistence and schema.
- `sales.js`, `inventory.js`, `accounting.js`: shared business rules.
- `sync.js`: durable synchronization primitives and protocol.

## Run

Requires Node.js 20 or newer.

```sh
cd DavinciPos
npm install
npm start
```

Open `http://localhost:3000/desktop` on a computer or `http://localhost:3000/mobile` on a phone connected to the same LAN.

## Architecture decisions

The server-side SQLite database is the authoritative store. Business rules are shared by both interfaces. The desktop and mobile interfaces are intentionally separate presentations.

The first milestone establishes the schema, API boundary, and domain modules. It is not yet a production-ready offline client: Electron will use the native SQLite adapter, and the Android Capacitor build will use a Capacitor SQLite adapter. Both adapters must implement the same repository contract before offline operation is enabled on those platforms.

Amounts are stored as integer minor units (for example, cents/piasters) to avoid floating-point accounting errors. Every posted journal entry must balance. Posted financial records are corrected by reversal, not destructive deletion.
