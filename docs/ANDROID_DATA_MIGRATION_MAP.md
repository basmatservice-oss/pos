# Android Local Data and Business-Operation Migration Map

## Current runtime boundary

- Android normal startup validates and reads its business snapshot from native SQLite. It does not initialize or hydrate Dexie after the one-time import.
- Windows Server uses its authoritative SQLite/Drizzle database through the local API.
- Windows Electron Client and Android local modes use the native SQLite repository and durable SQLite outbox.
- Dexie remains in the dependency graph for legacy IndexedDB migration and non-Electron/browser compatibility. It is not safe to remove until those migration and compatibility paths have an explicit retirement policy.
- `src/services/nativeDatabaseMirror.ts` is now restricted to importing a legacy IndexedDB snapshot once and validating the resulting SQLite snapshot. The obsolete per-write Dexie-to-SQLite mirror hooks have been removed.

## Current native repository coverage

The native repository registry covers the following persisted entities:

| Domain | Entities |
|---|---|
| Catalog | products, categories, unitDefinitions, productUnits, serviceRecipes |
| Sales | orders, orderItems, returns, returnItems, heldOrders, loyaltyTransactions |
| Purchasing | purchases, purchaseItems, purchaseReturns, purchaseReturnItems, suppliers, supplierPayments |
| Inventory | inventoryBatches, inventoryMovements, inventoryAlerts, stocktakingSessions, stocktakingEntries |
| Finance | accounts, journalEntries, transactions, expenses, customerPayments, fiscalPeriods, exchangeRateHistory |
| Workforce | employees, attendance, payroll, shifts, shiftMovements |
| Administration | settings, branches, offers, auditLogs |
| Replication | durable operations in the native SQLite outbox |

Repository coverage is not by itself proof that every page mutation is correctly routed through it. UI writes must continue to use `posDataAccess` or the operation dispatcher; stock, balances, accounting and source-document changes must not bypass business operations.

## Automated validation baseline (2026-11-25)

The CI unit-test command now executes both `tests/*.test.js` and `tests/*.test.ts`; the TypeScript integration suites are no longer silently excluded. The full current run completed 146/146 tests with zero failures, plus the Python purchase/currency migration test, TypeScript validation, browser build, native SQLite frontend build, and native renderer no-Dexie bundle check. This is automated CI evidence only, not physical-device verification.

The expanded run exposed and led to fixes for the seeded administrator's first-login test credentials and numeric PIN validation, and clarified the weighted-average inventory contract. Under weighted-average costing, remaining batch carrying values are revalued to the active average so later issues do not silently revert to FIFO layers; original purchase costs remain recorded on purchase-item and receipt-movement history. Switching methods does not rewrite historical sale cost snapshots. Server/native weighted-average and stocktake parity tests assert matching carrying values.

## Business operation coverage and proof still required

The native operation dispatcher contains local SQLite paths for sales, sales returns and voids, purchase creation/update/deletion, purchase returns, expenses, customer and supplier payments, payroll, shift operations, stocktake approval, and entity synchronization. Each path still requires operation-specific parity evidence against the Windows server implementation.

Current accounting parity tests exercise sale/partial-return valuation, FIFO and weighted-average costing, journal/COGS reversal behavior, stocktake valuation, service recipes/bundles, and a server-versus-native purchase create → update → sale → sale return → purchase return sequence. Purchase update coverage now compares supplier balance, journal reversal/replacement values, batch replacement, inventory movement reversal, stock/cost/total values and the linked USD cost anchor. It also rejects edits after batch consumption without changing stock or the invoice, and checks duplicate operation replay does not duplicate ledger or stock effects. Supplier changes, landed-cost allocation, paid invoices, extra-cost payment methods, multi-batch edge cases and stale-version rejection remain unproven. Purchase deletion has a separate native valuation test. The remaining release evidence is:

1. Extend purchase create/update/delete parity to landed-cost allocation, supplier changes, paid invoices, extra-cost payment methods, partially consumed batches, purchase returns followed by edits, and concurrent/stale-version rejection.
2. Expand purchase-return parity across returned quantity limits, batch depletion, supplier credit/cash effects and accounting reversals, including mixed-unit and repeated-line scenarios.
3. End-to-end parity for expenses, customer/supplier payments, payroll, shifts and stocktake.
4. Restart/crash tests around staged outbox operations, acknowledgement, retry, conflict and idempotent replay.
5. Full route audit proving that no Android page or service writes business records directly to Dexie or IndexedDB after startup.
6. Shared executable tests cover pending/error/conflict snapshot filtering, mixed SQLite/Dexie state metadata and pull-path wiring. Runtime integration tests against real SQLite and Dexie databases are still required, especially for entities without a business-level syncStatus field and outbox conflict/staging states.
7. Existing Android IndexedDB and Windows Electron legacy migration verification, including preserved keys and pending operations.

## Transaction dispatcher inventory

All server operation types requiring a matching local implementation or an explicit unsupported/conflict policy:

- `sale`
- `return`
- `order_void`
- `purchase`
- `purchase_update`
- `purchase_delete`
- `purchase_return`
- `expense`
- `expense_delete`
- `customer_payment`
- `supplier_payment`
- `payroll`
- `shift_open`
- `shift_close`
- `shift_movement`
- `stocktake_approve`
- `entity_upsert`
- `entity_delete`

## Product-unit model audit

The current POS and inventory screens still read and write alternate units through the legacy `products.unitsJson` field, and the cart derives unit choices from `product.unit`, `product.conversionFactor`, and `unitsJson`. The newer `unitDefinitions` and `productUnits` tables are registered in the database/repository but are not yet the active source used by those screens or the cart.

This is a parallel data model, not proof that the same rows are already duplicated in storage. Do not populate both representations independently. Until a data migration and all readers/writers are moved together, keep the legacy fields authoritative and normalize the selectable unit list in one shared helper. A future cutover must:
1. map each legacy unit name to a stable `unitDefinitions.code` without losing Arabic/custom names;
2. create one base `productUnits` row with conversion factor 1 and map alternate units with their exact conversion factors, prices and barcodes;
3. reject cross-dimension conversions and duplicate unit codes per product;
4. update Inventory, POS, purchase entry, recipes, stock movements, historical COGS and server APIs in one coordinated release;
5. preserve legacy records until reconciliation proves every product has equivalent structured units.

## Accounting parity requirements

The Android local engine must preserve the behavior of `server/accounting.ts`, not just persist a business row:

- double-entry journal lines and balanced debit/credit totals;
- system chart of accounts and account balances;
- FIFO batch allocation and restoration;
- weighted-average cost recalculation when configured;
- inventory movement history and stock alerts;
- return/void reversal behavior and closed-period protections;
- atomic transaction boundaries with the business record and durable outbox;
- operation-ID idempotency across retries and process restarts.

## Identity and migration rules

The existing Dexie schema contains numeric auto-increment keys alongside string IDs. Those values cannot safely be treated as globally unique across independent devices. Preserve legacy keys, use stable operation/device identities for replication, and validate every foreign-key remapping.

Do not remove Dexie from dependencies or delete the legacy import code until all supported legacy installation paths have been migrated or deliberately retired, and the browser compatibility path has been removed or replaced.

## Release gate

A successful TypeScript check or package build is necessary but does not prove accounting parity or functional correctness. Do not declare Android standalone, Windows client, or Dexie retirement complete until the operation parity, migration, synchronization, UI route and restart/crash test campaigns above have passed.
