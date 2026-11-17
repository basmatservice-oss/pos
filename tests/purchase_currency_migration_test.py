import re
import sqlite3
from pathlib import Path

pattern = re.compile(r"ensureColumn\(sqlite, '([^']+)', '([^']+)', '([^']*)'\);")
pattern = re.compile(r"ensureColumn\\(sqlite, '([^']+)', '([^']+)', '([^']*)'\\);")
targets = {"Purchase", "PurchaseItem", "InventoryBatch"}
columns = [(table, column, definition) for table, column, definition in pattern.findall(source) if table in targets]

required = {
    "Purchase": {"currencyCode", "baseCurrencyCode", "exchangeRate", "exchangeRateId", "originalTotalAmount", "originalPaidAmount"},
    "PurchaseItem": {"originalCostPrice", "originalTotal", "currencyCode", "exchangeRate", "exchangeRateId"},
    "InventoryBatch": {"originalCostPrice", "currencyCode", "exchangeRate", "exchangeRateId"},
}
found = {(table, column) for table, column, _ in columns}
for table, names in required.items():
    missing = names - {column for t, column in found if t == table}
    assert not missing, f"Missing migration columns for {table}: {sorted(missing)}"

connection = sqlite3.connect(":memory:")
connection.executescript("""
CREATE TABLE Purchase (id TEXT PRIMARY KEY, totalAmount REAL NOT NULL, paidAmount REAL);
CREATE TABLE PurchaseItem (id INTEGER PRIMARY KEY, purchaseId TEXT, costPrice REAL NOT NULL, total REAL NOT NULL);
CREATE TABLE InventoryBatch (id TEXT PRIMARY KEY, costPrice REAL NOT NULL, purchaseDate TEXT NOT NULL);
INSERT INTO Purchase (id, totalAmount, paidAmount) VALUES ('legacy-purchase', 125.50, 25.50);
INSERT INTO PurchaseItem (id, purchaseId, costPrice, total) VALUES (7, 'legacy-purchase', 12.55, 125.50);
INSERT INTO InventoryBatch (id, costPrice, purchaseDate) VALUES ('legacy-batch', 12.55, '2026-01-01');
""")

def apply_currency_columns():
    for table, column, definition in columns:
        existing = {row[1] for row in connection.execute(f'PRAGMA table_info("{table}")')}
        if column not in existing:
            connection.execute(f'ALTER TABLE "{table}" ADD COLUMN "{column}" {definition}')

apply_currency_columns()
apply_currency_columns()  # Idempotency: a second startup must not fail.
assert connection.execute("SELECT totalAmount, paidAmount FROM Purchase WHERE id='legacy-purchase'").fetchone() == (125.5, 25.5)
assert connection.execute("SELECT costPrice, total FROM PurchaseItem WHERE id=7").fetchone() == (12.55, 125.5)
assert connection.execute("SELECT costPrice FROM InventoryBatch WHERE id='legacy-batch'").fetchone() == (12.55,)
for table, names in required.items():
    for column in names:
        assert connection.execute(f'PRAGMA table_info("{table}")').fetchall()
        value = connection.execute(f'SELECT "{column}" FROM "{table}" LIMIT 1').fetchone()[0]
        assert value is None, f"Legacy {table}.{column} should remain NULL, got {value!r}"

print("Purchase currency migration: legacy values preserved; new columns added; rerun is idempotent.")
