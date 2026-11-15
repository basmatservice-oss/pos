# DavinciPos

DavinciPos is a clean rebuild of the legacy POS application. The legacy application remains untouched.

## Flat project layout

Every authored project file is placed directly in this directory. There are no nested source folders.

- `desktop.html` / `desktop.css` / `desktop.js`: desktop-first interface.
- `mobile.html` / `mobile.css` / `mobile.js`: independent mobile interface.
- `server.js`: HTTP API and application bootstrap.
- `database.js` / `schema.sql`: SQLite persistence and schema.
- `sales.js`, `purchases.js`, `inventory.js`, `tax.js`, `accounting.js`: shared business rules; accounting remains internal and is not exposed as an everyday workflow.
- `reports.js`: date-filtered detailed reports for daily sales, sales invoices/products/categories/customers/payment methods, sales and purchase returns, purchase invoices/products/categories/payment methods, stock balances and movements, tax summary, and cash receipts/payments. The simplified summary remains available as well.
- `sync.js` / `offline.js`: outbox primitives, device-bound idempotent server reconciliation, payload-integrity checks, and stock-conflict review. The client-side durable SQLite outbox adapters are still pending.
- `security.js`: password hashing, expiring sessions, role permissions and account management.
- `catalog.js`: products, alternate sales units and conversion factors, barcode lookup, service catalog and service material recipes, categories, customers and suppliers.
- `currency.js`: USD/SDG exchange-rate history and optional automatic repricing for products whose source prices are maintained in USD.
- `expenses.js`: simple store expenses with payment method/provider, automatic internal posting, and net-profit reporting.
- `returns.js`: sales and purchase returns with quantity limits, stock restoration/removal, payment refunds, customer/supplier balance reconciliation, audit records and internal accounting.
- Inventory supports draft physical stock counts, barcode-based counting, and posting stock differences through audited adjustments.
- The desktop and mobile interfaces include product management, stock adjustments, customer/supplier records, server-quoted sales checkout, purchase receiving, return processing from invoice lists, selectable detailed store reports, central settings, user roles and sync conflict review. Wallet payments can be distinguished as Bankak, OCash, Fawry or MyCashy while retaining a common wallet clearing account.
- `settings.js`: server-owned settings with validation and audit history.
- `client.js`: shared authenticated API and settings/user administration UI.

## Database and clean migration

DavinciPos uses its own `DavinciPos.sqlite` file (or the path supplied by `DAVINCIPOS_DB`). It does not import or migrate legacy POS records. The legacy database and legacy application are left untouched. The initial DavinciPos database starts with an empty catalog, customers, suppliers, transactions and users; only required system defaults such as the main branch, units, chart of accounts and settings are seeded. The first owner is created through the one-time bootstrap flow. Existing DavinciPos databases are upgraded in place by the DavinciPos schema initialization; this is separate from importing the legacy database.

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

## Device-side offline storage milestone

- `local-store.js` introduces a persistent browser IndexedDB store for queued offline sales, retry state, acknowledgements, conflict holds and device metadata.
- The server-side sync receipt still binds each operation ID to its originating registered device and payload hash.
- `sync.test.js` covers the server outbox lifecycle; `local-store.test.js` covers local sale-envelope validation and refuses silent in-memory fallback when IndexedDB is unavailable.
- This is the storage foundation, not the completed offline checkout: the sales UI still depends on server-loaded catalog/quotes and must be connected to this store, then paired with native SQLite adapters for Electron and Android Capacitor before offline operation can be accepted.

## Local LAN / Wi-Fi deployment (internet is not required)

DavinciPos is a local-network application. When the cashier devices and the host computer are connected to the same Ethernet LAN or Wi-Fi network, sales, stock, reports and central SQLite transactions work through the host even if the router has no WAN/Internet connection. The router/access point only provides local connectivity; it does not need an Internet uplink.

### Host computer

1. Give the host computer a reserved/static LAN address, for example `192.168.1.10`.
2. From this directory, generate a local CA and a server certificate whose SAN contains the host IP:
   `LAN_IP=192.168.1.10 LAN_DNS=davincipos.local sh generate-lan-certificate.sh`
3. Copy `.env.example` to `.env`. Set `HOST=0.0.0.0`, `PORT=3000`, `TLS_CERT_PATH=./lan-cert.pem`, `TLS_KEY_PATH=./lan-key.pem`, and a long one-time bootstrap token.
4. Start with `npm run start:lan`.
5. Allow inbound TCP port 3000 in the host firewall for the **Private/local network only**. Do not expose it to the public Internet or configure router port forwarding.
6. Keep the CA private key and server private key on the host. Never copy either private key to cashier devices.

### Client devices

- Install and trust `davincipos-local-ca.crt` on each managed desktop/Android device, then open `https://192.168.1.10:3000/desktop` or `https://192.168.1.10:3000/mobile`.
- If using the local DNS name, configure it in the LAN DNS/router and use the matching certificate name.
- Do not bypass certificate warnings. A trusted HTTPS certificate is required for secure browser features and authenticated LAN access.
- Register each POS device with its own device identity. Use the same server URL on every device.

### Operating modes and data authority

- **Internet down, LAN up:** fully connected operation continues normally. Every device sends requests to the same local server and central SQLite database; no cloud service is involved.
- **LAN down for one terminal:** local durable queueing and later synchronization is a separate offline-terminal mode. The IndexedDB outbox currently provides the persistence foundation; the sales screen still needs the complete cached-catalog, local quote, queued checkout and automatic replay integration before this mode is accepted.
- **Host computer down:** other terminals cannot reach the central database. A separate high-availability/server-recovery design is required; do not allow independent terminals to write competing copies of the central SQLite database.

SQLite must remain on the host machine's local disk. Never place the SQLite database file on a shared SMB/NAS/network folder and let multiple clients open it directly. Clients communicate with the host API over LAN instead.
