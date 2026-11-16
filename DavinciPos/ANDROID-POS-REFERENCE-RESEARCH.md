# POS Reference Review — DavinciPos

Review date: 2026-11-16

This review uses public product documentation and repository descriptions as architectural references. It does not copy source code, assets, or licensed implementation details. Feature claims are treated as product-reported capabilities, not independent proof of production reliability.

## References reviewed

| Reference | Useful design patterns | Relevance to DavinciPos |
|---|---|---|
| Kaup (Android, Kotlin, Room) | Local-first transaction ownership, optional pluggable sync, stock movement ledger, FIFO, split tenders, offline manager approval, role permissions, shift close/cash-up | Closest Android architecture reference. Adopt the separation of local transaction execution from optional synchronization and a clear stock movement ledger. |
| X POS / ERPNext | Offline sales queue, cached master data, sync status, purchase orders and receiving, linked returns, credit limits, batch/serial selection, mixed currency, granular permission flags | Useful for completing purchasing, return and synchronization workflows, but its ERPNext dependency and online/offline limitations must not be confused with DavinciPos' LAN server model. |
| Odoo POS | Session lifecycle, offline checkout, split tenders, product movement integration and consolidated multi-shop reporting | Reference for POS session/cash control and consistent stock posting. |
| ERPNext return documents | Separate physical stock return from credit/debit note; link returns to source invoice; cap cumulative returned quantity; preserve original valuation; prevent duplicate stock reversal | Adopt these accounting and inventory invariants in the Kotlin return implementation and later close the remaining parity gaps. |
| Posnic | Shop-hosted local API/database, multiple tills on a self-hosted server, returns, part payments, held bills, inventory logs, expenses, reports and branches | Closest deployment pattern to a Windows-hosted LAN server accessed by Android/desktop clients without requiring internet. |

## Decisions for DavinciPos

1. Keep the Windows computer as the authoritative LAN server for shared multi-device mode. Android and desktop clients must connect over the same Wi-Fi/LAN without a cloud dependency.
2. Keep Android's local SQLite mode for independent offline operation. Do not silently treat a disconnected LAN client as an authoritative writer to the shared server database; offline transactions need an explicit durable outbox, stable IDs, replay policy and conflict handling before synchronization is enabled.
3. Preserve a single stock movement ledger and inventory-layer valuation. Every sale, purchase receipt, return, transfer, count and adjustment must reconcile with that ledger and the general ledger.
4. Treat a return as a source-linked document. Validate the unreturned quantity against the original invoice and prior returns, restore the exact original FIFO layers where sale allocations exist, and prevent duplicate stock/accounting effects.
5. Keep refunds and credit balances distinct: the amount already collected or paid caps the cash refund; the remaining value changes customer receivables or supplier payables.
6. Make shift open/close, cash reconciliation, held/draft sales, payment mix and audit history first-class workflows rather than UI-only conveniences.
7. Use role permissions for refunds, voids, discounts, price overrides and cash movements; require manager approval for sensitive overrides, including when internet access is unavailable.
8. Use a local durable sync queue only for a future offline-to-LAN reconciliation layer. A queue must expose pending, synced and failed states, retry safely, and never replay financial postings twice.

## Current port status and gaps

- Kotlin local purchase quote/receipt and invoice history are wired.
- Kotlin local linked sales and purchase return options/posting are now wired through the authenticated bridge.
- Sales FIFO returns restore the source inventory layers using sale-line allocation references; weighted returns use the recorded sale-line unit cost fallback.
- Purchase returns use the configured inventory valuation method and reconcile supplier credit/refund, input tax and purchase variance.
- Remaining major areas include complete sales checkout parity and routes, void/cancel/reversal flows, sales/purchase return cancellation, full reports, shift lifecycle/cash-up, LAN/offline outbox and replay, batch/serial tracking, and reconciliation of returns in all statements and reports.
- No Android Node.js runtime removal is authorized until the route matrix is complete and the Android build plus device/LAN workflows are proven.

## Source links

- Kaup: https://github.com/rons-space/Kaup
- X POS: https://github.com/kodlyft/xpos
- Odoo POS: https://www.odoo.com/documentation/18.0/applications/sales/point_of_sale.html
- ERPNext sales return: https://docs.frappe.io/erpnext/sales-return
- ERPNext purchase return: https://docs.frappe.io/erpnext/purchase-return
- Posnic: https://github.com/Posnic/POS
