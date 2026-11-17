# Android Local Data and Business-Operation Migration Map

Source inspected on the packaging branch:
- Browser persistence: `src/db/db.ts`, Dexie schema version 23.
- Server transaction dispatcher: `server/operations.ts`.
- Server accounting primitives: `server/accounting.ts`.
- Client replication/outbox: `src/services/syncService.ts`.
- HTTP boundary: `src/services/apiService.ts`.

## Current browser schema inventory (Dexie v23)

The Android local persistence migration must cover every store below; a partial migration must not be described as full POS support.

| Domain | Stores |
|---|---|
| Catalog | products, categories, unitDefinitions, productUnits, serviceRecipes |
| Sales | orders, orderItems, returns, returnItems, heldOrders, loyaltyTransactions |
| Purchasing | purchases, purchaseItems, purchaseReturns, purchaseReturnItems, suppliers, supplierPayments |
| Inventory | inventoryBatches, inventoryMovements, inventoryAlerts, stocktakingSessions, stocktakingEntries |
| Finance | accounts, journalEntries, transactions, expenses, customerPayments, fiscalPeriods, exchangeRateHistory |
| Workforce | employees, attendance, payroll, shifts, shiftMovements |
| Administration | settings, branches, offers, auditLogs |
| Replication | syncOperations |

## Transaction dispatcher inventory

All server operation types that need a local equivalent or an explicit unsupported/conflict policy:

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

## Accounting parity requirements

The Android local engine must preserve the behavior of `server/accounting.ts`, not just persist a sale row:
- double-entry journal lines and balanced debit/credit totals;
- system chart of accounts and account balances;
- FIFO batch allocation and restoration;
- weighted-average cost recalculation when configured;
- inventory movement history and stock alerts;
- return/void reversal behavior and closed-period protections;
- atomic transaction boundaries with the business record and outbox.

## Data identity and migration rules

The existing Dexie schema contains many numeric auto-increment keys alongside string IDs. Those values cannot safely be treated as globally unique across independent devices. The migration must add stable UUID identities for replicated records, preserve legacy keys for compatibility, and define foreign-key mapping per table.

The native SQLite generic-record store is an initial durable persistence substrate. It does not yet replace the Dexie stores, nor does it yet implement the above business transactions. Keep the current Android mode on the existing client path until the local repository and transaction engine are fully connected.

## Deferred validation

Per the agreed delivery sequence, functional test campaigns are deferred until implementation and generation of all three deliverables are complete. The build workflow may still compile/package the native sources to expose build blockers; that is packaging feedback, not a completed functional test campaign.
