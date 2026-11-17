import re
import sqlite3
from pathlib import Path

source = Path("migrate.ts").read_text(encoding="utf-8")
pattern = re.compile(r"ensureColumn\\(sqlite, '([^']+)', '([^']+)', '([^']*)'\\);")
targets = {
    "Product", "OrderItem", "Purchase", "PurchaseItem", "InventoryBatch",
    "ReturnItem", "PurchaseReturnItem", "StocktakingEntry", "AuditLog",
}
columns = [(table, column, definition) for table, column, definition in pattern.findall(source) if table in targets]

required = {
    "Product": {"baseUnitCode", "quantityPrecision"},
    "OrderItem": {"unitCode", "baseUnitCode", "conversionToBase", "baseQuantity"},
    "InventoryBatch": {"unitCode", "baseUnitCode", "conversionToBase", "baseQuantity"},
    "PurchaseItem": {"unitCode", "baseUnitCode", "conversionToBase", "baseQuantity"},
    "ReturnItem": {"unitCode", "baseUnitCode", "conversionToBase", "baseQuantity"},
    "PurchaseReturnItem": {"unitCode", "baseUnitCode", "conversionToBase", "baseQuantity"},
    "StocktakingEntry": {"unitCode", "baseUnitCode"},
    "AuditLog": {"unitCode"},
}
found = {(table, column) for table, column, _ in columns}
for table, names in required.items():
    missing = names - {column for t, column in found if t == table}
    assert not missing, f"Missing unit migration columns for {table}: {sorted(missing)}"

connection = sqlite3.connect(":memory:")
connection.executescript("""
CREATE TABLE Product (id INTEGER PRIMARY KEY, stockQuantity INTEGER, minStockLevel INTEGER, unit TEXT, conversionFactor INTEGER);
CREATE TABLE OrderItem (id INTEGER PRIMARY KEY, quantity INTEGER NOT NULL, returnedQuantity INTEGER, conversionFactor INTEGER);
CREATE TABLE Purchase (id TEXT PRIMARY KEY, totalAmount REAL NOT NULL, paidAmount REAL);
CREATE TABLE PurchaseItem (id INTEGER PRIMARY KEY, purchaseId TEXT, quantity INTEGER NOT NULL, costPrice REAL NOT NULL, total REAL NOT NULL);
CREATE TABLE InventoryBatch (id TEXT PRIMARY KEY, quantity INTEGER NOT NULL, remainingQuantity INTEGER NOT NULL, costPrice REAL NOT NULL, purchaseDate TEXT NOT NULL);
CREATE TABLE ReturnItem (id TEXT PRIMARY KEY, quantity INTEGER NOT NULL, unitPrice REAL NOT NULL, total REAL NOT NULL);
CREATE TABLE PurchaseReturnItem (id TEXT PRIMARY KEY, quantity INTEGER NOT NULL, costPrice REAL NOT NULL, total REAL NOT NULL);
CREATE TABLE StocktakingEntry (id TEXT PRIMARY KEY, systemQuantity INTEGER NOT NULL, actualQuantity INTEGER NOT NULL);
CREATE TABLE AuditLog (id INTEGER PRIMARY KEY, quantity INTEGER);
INSERT INTO Product VALUES (1, 10, 2, 'piece', 12);
INSERT INTO OrderItem VALUES (1, 3, 0, 12);
INSERT INTO Purchase VALUES ('legacy-purchase', 125.50, 25.50);
INSERT INTO PurchaseItem VALUES (7, 'legacy-purchase', 10, 12.55, 125.50);
INSERT INTO InventoryBatch VALUES ('legacy-batch', 10, 10, 12.55, '2026-01-01');
INSERT INTO ReturnItem VALUES ('legacy-return-item', 1, 12.55, 12.55);
INSERT INTO PurchaseReturnItem VALUES ('legacy-purchase-return-item', 1, 12.55, 12.55);
INSERT INTO StocktakingEntry VALUES ('legacy-stocktake', 10, 9);
INSERT INTO AuditLog VALUES (1, 1);
""")

# Execute the exact additive table definitions from migrate.ts for the new UOM master tables.
for table, body in re.findall(r'CREATE TABLE IF NOT EXISTS "(UnitDefinition|ProductUnit)" \\((.*?)\\);', source, re.S):
    connection.execute(f'CREATE TABLE IF NOT EXISTS "{table}" ({body})')

def apply_additive_columns():
    for table, column, definition in columns:
        existing = {row[1] for row in connection.execute(f'PRAGMA table_info("{table}")')}
        if column not in existing:
            connection.execute(f'ALTER TABLE "{table}" ADD COLUMN "{column}" {definition}')

apply_additive_columns()
apply_additive_columns()  # Re-running startup migration must remain safe.

assert connection.execute("SELECT stockQuantity, conversionFactor FROM Product WHERE id=1").fetchone() == (10, 12)
assert connection.execute("SELECT quantity FROM OrderItem WHERE id=1").fetchone() == (3,)
assert connection.execute("SELECT totalAmount, paidAmount FROM Purchase WHERE id='legacy-purchase'").fetchone() == (125.5, 25.5)
assert connection.execute("SELECT costPrice, total FROM PurchaseItem WHERE id=7").fetchone() == (12.55, 125.5)
assert connection.execute("SELECT costPrice FROM InventoryBatch WHERE id='legacy-batch'").fetchone() == (12.55,)

# SQLite INTEGER affinity still stores a fractional REAL value; the Drizzle schema can safely read it as a number.
connection.execute("UPDATE Product SET stockQuantity=2.5 WHERE id=1")
connection.execute("UPDATE OrderItem SET quantity=0.25 WHERE id=1")
connection.execute("UPDATE InventoryBatch SET remainingQuantity=1.75 WHERE id='legacy-batch'")
assert connection.execute("SELECT stockQuantity, typeof(stockQuantity) FROM Product WHERE id=1").fetchone() == (2.5, "real")
assert connection.execute("SELECT quantity, typeof(quantity) FROM OrderItem WHERE id=1").fetchone() == (0.25, "real")
assert connection.execute("SELECT remainingQuantity, typeof(remainingQuantity) FROM InventoryBatch WHERE id='legacy-batch'").fetchone() == (1.75, "real")

assert connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='UnitDefinition'").fetchone()
assert connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='ProductUnit'").fetchone()
print("UOM migration: additive columns and unit tables verified; legacy rows preserved; fractional quantities remain representable.")
