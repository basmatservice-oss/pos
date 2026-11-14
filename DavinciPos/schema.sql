PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','manager','cashier','accountant','sales')),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('desktop','android','web')),
  branch_id TEXT REFERENCES branches(id), owner_user_id TEXT REFERENCES users(id), is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)), last_seen_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#64748b',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS units (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, symbol TEXT NOT NULL,
  precision INTEGER NOT NULL DEFAULT 0 CHECK (precision BETWEEN 0 AND 6)
);
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY, sku TEXT UNIQUE, barcode TEXT UNIQUE, name TEXT NOT NULL,
  category_id TEXT REFERENCES categories(id), base_unit_id TEXT NOT NULL REFERENCES units(id),
  cost_minor INTEGER NOT NULL DEFAULT 0 CHECK (cost_minor >= 0),
  sale_price_minor INTEGER NOT NULL DEFAULT 0 CHECK (sale_price_minor >= 0),
  tax_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bps BETWEEN 0 AND 10000),
  tax_exempt INTEGER NOT NULL DEFAULT 0 CHECK(tax_exempt IN (0,1)), track_stock INTEGER NOT NULL DEFAULT 1 CHECK (track_stock IN (0,1)),
  min_stock REAL NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS product_units (
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
  unit_id TEXT NOT NULL REFERENCES units(id), base_quantity REAL NOT NULL CHECK (base_quantity > 0),
  barcode TEXT UNIQUE, sale_price_minor INTEGER CHECK (sale_price_minor >= 0),
  is_default_sale INTEGER NOT NULL DEFAULT 0 CHECK (is_default_sale IN (0,1)),
  UNIQUE(product_id, unit_id)
);
CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY, code TEXT UNIQUE, name TEXT NOT NULL,
  price_minor INTEGER NOT NULL CHECK (price_minor >= 0), tax_rate_bps INTEGER NOT NULL DEFAULT 0, tax_exempt INTEGER NOT NULL DEFAULT 0 CHECK(tax_exempt IN (0,1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS service_components (
  id TEXT PRIMARY KEY, service_id TEXT NOT NULL REFERENCES services(id),
  product_id TEXT NOT NULL REFERENCES products(id), quantity REAL NOT NULL CHECK (quantity > 0)
);
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT, email TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT, email TEXT, address TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY, receipt_number TEXT NOT NULL UNIQUE,
  branch_id TEXT REFERENCES branches(id), device_id TEXT REFERENCES devices(id),
  customer_id TEXT REFERENCES customers(id), cashier_id TEXT REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('draft','posted','partially_returned','returned','void')),
  subtotal_minor INTEGER NOT NULL CHECK (subtotal_minor >= 0),
  discount_minor INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  tax_minor INTEGER NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor INTEGER NOT NULL CHECK (total_minor >= 0), currency_code TEXT NOT NULL DEFAULT 'SDG',
  occurred_at TEXT NOT NULL, created_at TEXT NOT NULL,
  tax_enabled INTEGER NOT NULL DEFAULT 1 CHECK(tax_enabled IN (0,1)), tax_price_mode TEXT NOT NULL DEFAULT 'exclusive' CHECK(tax_price_mode IN ('inclusive','exclusive'))
);
CREATE TABLE IF NOT EXISTS sale_lines (
  id TEXT PRIMARY KEY, sale_id TEXT NOT NULL REFERENCES sales(id),
  line_type TEXT NOT NULL CHECK (line_type IN ('product','service')), item_id TEXT NOT NULL,
  description TEXT NOT NULL, quantity REAL NOT NULL CHECK (quantity > 0), unit_name TEXT NOT NULL,
  base_quantity REAL NOT NULL DEFAULT 0 CHECK (base_quantity >= 0),
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  unit_cost_minor INTEGER NOT NULL DEFAULT 0 CHECK (unit_cost_minor >= 0),
  cost_total_minor INTEGER NOT NULL DEFAULT 0 CHECK (cost_total_minor >= 0),
  discount_minor INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  tax_minor INTEGER NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  line_total_minor INTEGER NOT NULL CHECK (line_total_minor >= 0),
  tax_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK(tax_rate_bps BETWEEN 0 AND 10000), tax_profile_id TEXT,
  tax_price_mode TEXT NOT NULL DEFAULT 'exclusive' CHECK(tax_price_mode IN ('inclusive','exclusive'))
);
CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY, invoice_number TEXT NOT NULL UNIQUE, supplier_id TEXT REFERENCES suppliers(id),
  branch_id TEXT REFERENCES branches(id), status TEXT NOT NULL CHECK(status IN ('posted','void')),
  subtotal_minor INTEGER NOT NULL CHECK(subtotal_minor>=0), discount_minor INTEGER NOT NULL DEFAULT 0 CHECK(discount_minor>=0),
  total_minor INTEGER NOT NULL CHECK(total_minor>=0), currency_code TEXT NOT NULL DEFAULT 'SDG',
  occurred_at TEXT NOT NULL, created_at TEXT NOT NULL, tax_minor INTEGER NOT NULL DEFAULT 0 CHECK(tax_minor>=0),
  tax_treatment TEXT NOT NULL DEFAULT 'disabled' CHECK(tax_treatment IN ('recoverable','non_recoverable','disabled')),
  tax_price_mode TEXT NOT NULL DEFAULT 'exclusive' CHECK(tax_price_mode IN ('inclusive','exclusive'))
);
CREATE TABLE IF NOT EXISTS purchase_lines (
  id TEXT PRIMARY KEY, purchase_id TEXT NOT NULL REFERENCES purchases(id), product_id TEXT NOT NULL REFERENCES products(id),
  quantity REAL NOT NULL CHECK(quantity>0), unit_name TEXT NOT NULL, base_quantity REAL NOT NULL CHECK(base_quantity>0),
  unit_cost_minor INTEGER NOT NULL CHECK(unit_cost_minor>=0), discount_minor INTEGER NOT NULL DEFAULT 0 CHECK(discount_minor>=0),
  line_total_minor INTEGER NOT NULL CHECK(line_total_minor>=0), tax_minor INTEGER NOT NULL DEFAULT 0 CHECK(tax_minor>=0),
  tax_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK(tax_rate_bps BETWEEN 0 AND 10000), tax_profile_id TEXT,
  tax_price_mode TEXT NOT NULL DEFAULT 'exclusive' CHECK(tax_price_mode IN ('inclusive','exclusive'))
);
CREATE TABLE IF NOT EXISTS purchase_payments (
  id TEXT PRIMARY KEY, purchase_id TEXT NOT NULL REFERENCES purchases(id), method TEXT NOT NULL CHECK(method IN ('cash','card','bank','wallet','other')),
  amount_minor INTEGER NOT NULL CHECK(amount_minor>0), reference TEXT, provider TEXT, occurred_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY, sale_id TEXT REFERENCES sales(id),
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  method TEXT NOT NULL CHECK (method IN ('cash','card','bank','wallet','credit','other')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0), reference TEXT, provider TEXT, occurred_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stock_movements (
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
  branch_id TEXT REFERENCES branches(id), source_type TEXT NOT NULL, source_id TEXT NOT NULL,
  quantity_delta REAL NOT NULL CHECK (quantity_delta <> 0), unit_cost_minor INTEGER NOT NULL DEFAULT 0,
  cost_total_minor INTEGER NOT NULL DEFAULT 0 CHECK (cost_total_minor >= 0),
  cost_method TEXT CHECK (cost_method IN ('weighted','fifo','opening','adjustment')),
  occurred_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inventory_layers (
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id), branch_id TEXT REFERENCES branches(id),
  source_type TEXT NOT NULL, source_id TEXT NOT NULL, received_quantity REAL NOT NULL CHECK (received_quantity > 0),
  remaining_quantity REAL NOT NULL CHECK (remaining_quantity >= 0 AND remaining_quantity <= received_quantity),
  unit_cost_minor INTEGER NOT NULL CHECK (unit_cost_minor >= 0), received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inventory_layers_fifo ON inventory_layers(product_id, branch_id, received_at, id);
CREATE TABLE IF NOT EXISTS tax_profiles (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, rate_bps INTEGER NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
  price_mode TEXT NOT NULL CHECK (price_mode IN ('inclusive','exclusive')), is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1))
);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('asset','liability','equity','revenue','expense')),
  normal_side TEXT NOT NULL CHECK (normal_side IN ('debit','credit')),
  parent_id TEXT REFERENCES accounts(id), is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1))
);
CREATE TABLE IF NOT EXISTS journal_entries (
  id TEXT PRIMARY KEY, entry_number TEXT NOT NULL UNIQUE, source_type TEXT NOT NULL, source_id TEXT NOT NULL,
  description TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('draft','posted','reversed')),
  occurred_at TEXT NOT NULL, posted_at TEXT, reversed_entry_id TEXT REFERENCES journal_entries(id),
  UNIQUE(source_type, source_id)
);
CREATE TABLE IF NOT EXISTS journal_lines (
  id TEXT PRIMARY KEY, journal_entry_id TEXT NOT NULL REFERENCES journal_entries(id),
  account_id TEXT NOT NULL REFERENCES accounts(id), debit_minor INTEGER NOT NULL DEFAULT 0 CHECK (debit_minor >= 0),
  credit_minor INTEGER NOT NULL DEFAULT 0 CHECK (credit_minor >= 0), memo TEXT,
  CHECK ((debit_minor > 0 AND credit_minor = 0) OR (credit_minor > 0 AND debit_minor = 0))
);
CREATE TRIGGER IF NOT EXISTS journal_entry_must_balance
BEFORE UPDATE OF status ON journal_entries
WHEN NEW.status='posted'
BEGIN
  SELECT CASE WHEN
    (SELECT COALESCE(SUM(debit_minor),0) FROM journal_lines WHERE journal_entry_id=NEW.id)
    !=
    (SELECT COALESCE(SUM(credit_minor),0) FROM journal_lines WHERE journal_entry_id=NEW.id)
    OR
    (SELECT COALESCE(SUM(debit_minor),0) FROM journal_lines WHERE journal_entry_id=NEW.id)=0
  THEN RAISE(ABORT, 'Journal entry must balance before posting') END;
END;
CREATE TABLE IF NOT EXISTS sync_outbox (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE,
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert','delete')),
  payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','acknowledged','failed')),
  attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, acknowledged_at TEXT, last_error TEXT
);
CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
CREATE INDEX IF NOT EXISTS idx_sales_occurred ON sales(occurred_at);
CREATE INDEX IF NOT EXISTS idx_sale_lines_sale ON sale_lines(sale_id);
CREATE INDEX IF NOT EXISTS idx_stock_product_time ON stock_movements(product_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_journal_lines_entry ON journal_lines(journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_outbox_status_created ON sync_outbox(status, created_at);

CREATE TRIGGER IF NOT EXISTS posted_journal_lines_no_insert
BEFORE INSERT ON journal_lines
WHEN (SELECT status FROM journal_entries WHERE id=NEW.journal_entry_id) IN ('posted','reversed')
BEGIN SELECT RAISE(ABORT,'Posted journal entries are immutable'); END;
CREATE TRIGGER IF NOT EXISTS posted_journal_lines_no_update
BEFORE UPDATE ON journal_lines
WHEN (SELECT status FROM journal_entries WHERE id=OLD.journal_entry_id) IN ('posted','reversed')
BEGIN SELECT RAISE(ABORT,'Posted journal entries are immutable'); END;
CREATE TRIGGER IF NOT EXISTS posted_journal_lines_no_delete
BEFORE DELETE ON journal_lines
WHEN (SELECT status FROM journal_entries WHERE id=OLD.journal_entry_id) IN ('posted','reversed')
BEGIN SELECT RAISE(ABORT,'Posted journal entries are immutable'); END;
CREATE TRIGGER IF NOT EXISTS posted_journal_entry_no_edit
BEFORE UPDATE OF entry_number,source_type,source_id,description,occurred_at ON journal_entries
WHEN OLD.status IN ('posted','reversed')
BEGIN SELECT RAISE(ABORT,'Posted journal entries are immutable'); END;

CREATE TRIGGER IF NOT EXISTS journal_entry_status_transition_guard
BEFORE UPDATE OF status ON journal_entries
WHEN (OLD.status='posted' AND NEW.status NOT IN ('posted','reversed'))
  OR (OLD.status='reversed' AND NEW.status!='reversed')
  OR (OLD.status='draft' AND NEW.status NOT IN ('draft','posted'))
BEGIN SELECT RAISE(ABORT,'Invalid journal entry status transition'); END;
CREATE TRIGGER IF NOT EXISTS posted_journal_entry_no_delete
BEFORE DELETE ON journal_entries
WHEN OLD.status IN ('posted','reversed')
BEGIN SELECT RAISE(ABORT,'Posted journal entries cannot be deleted'); END;


CREATE TABLE IF NOT EXISTS roles (
  name TEXT PRIMARY KEY, description TEXT NOT NULL, is_system INTEGER NOT NULL DEFAULT 0 CHECK(is_system IN (0,1))
);
CREATE TABLE IF NOT EXISTS role_permissions (
  role_name TEXT NOT NULL REFERENCES roles(name) ON DELETE CASCADE,
  permission TEXT NOT NULL, PRIMARY KEY(role_name,permission)
);
CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expiry ON user_sessions(expires_at);
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), action TEXT NOT NULL,
  entity_type TEXT NOT NULL, entity_id TEXT, details TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);
CREATE TABLE IF NOT EXISTS sync_conflicts (
  id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, device_id TEXT NOT NULL,
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, payload TEXT NOT NULL,
  reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','resolved','rejected')),
  created_at TEXT NOT NULL, resolved_at TEXT, resolved_by TEXT REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS sync_receipts (
  operation_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exchange_rates (
 id TEXT PRIMARY KEY,from_currency TEXT NOT NULL,to_currency TEXT NOT NULL,rate REAL NOT NULL CHECK(rate>0),
 effective_at TEXT NOT NULL,created_by TEXT REFERENCES users(id),created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exchange_rates_pair_date ON exchange_rates(from_currency,to_currency,effective_at DESC);
