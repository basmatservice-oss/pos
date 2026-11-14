import { randomUUID } from 'node:crypto';
import { db, inTransaction } from './database.js';
import { postJournalEntry } from './accounting.js';

const paymentAccounts = {
  cash: 'acc-cash', card: 'acc-card', bank: 'acc-bank',
  wallet: 'acc-wallet', other: 'acc-other-clearing'
};
const walletProviders = new Set(['bankak', 'ocash', 'fawry', 'mycashy']);

function auditPayment(actorUserId, action, id, details) {
  if (!actorUserId) return;
  db.prepare('INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,details,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(randomUUID(), actorUserId, action, 'payment', id, JSON.stringify(details), new Date().toISOString());
}

function validatePayment(input) {
  const amountMinor = Number(input?.amountMinor);
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new Error('Payment amount must be a positive integer in minor currency units.');
  }
  const method = input.method || 'cash';
  if (!paymentAccounts[method]) throw new Error('Unsupported payment method.');
  const provider = input.provider || null;
  if (provider && !walletProviders.has(provider)) throw new Error('Unsupported wallet provider.');
  if (method === 'wallet' && !provider) throw new Error('Select a supported wallet provider.');
  if (method !== 'wallet' && provider) throw new Error('A wallet provider is only valid for wallet payments.');
  return { amountMinor, method, provider, reference: input.reference || null,
    occurredAt: input.occurredAt || new Date().toISOString() };
}

export function recordCustomerPayment(saleId, input, actorUserId = null) {
  const payment = validatePayment(input);
  return inTransaction(() => {
    const sale = db.prepare("SELECT id,receipt_number,customer_id,total_minor,status FROM sales WHERE id=?").get(saleId);
    if (!sale || !sale.customer_id || !['posted','partially_returned'].includes(sale.status)) {
      throw new Error('Customer invoice not found or not eligible for collection.');
    }
    const paid = db.prepare("SELECT COALESCE(SUM(amount_minor),0) AS total FROM payments WHERE sale_id=? AND direction='in'").get(saleId).total;
    const due = sale.total_minor - paid;
    if (payment.amountMinor > due) throw new Error('Payment exceeds the remaining invoice balance.');
    const id = randomUUID();
    db.prepare("INSERT INTO payments(id,sale_id,direction,method,amount_minor,reference,provider,occurred_at) VALUES(?,?,'in',?,?,?,?,?)")
      .run(id, saleId, payment.method, payment.amountMinor, payment.reference, payment.provider, payment.occurredAt);
    postJournalEntry({ sourceType: 'sale_collection', sourceId: id,
      description: `Customer payment for ${sale.receipt_number}`, occurredAt: payment.occurredAt,
      lines: [
        { accountId: paymentAccounts[payment.method], debitMinor: payment.amountMinor },
        { accountId: 'acc-ar', creditMinor: payment.amountMinor }
      ] });
    auditPayment(actorUserId, 'customer.payment', id, { saleId, amountMinor: payment.amountMinor, method: payment.method });
    return { id, saleId, amountMinor: payment.amountMinor, remainingMinor: due - payment.amountMinor };
  });
}

export function recordSupplierPayment(purchaseId, input, actorUserId = null) {
  const payment = validatePayment(input);
  return inTransaction(() => {
    const purchase = db.prepare("SELECT id,invoice_number,supplier_id,total_minor,status FROM purchases WHERE id=?").get(purchaseId);
    if (!purchase || !purchase.supplier_id || purchase.status !== 'posted') {
      throw new Error('Supplier invoice not found or not eligible for payment.');
    }
    const paid = db.prepare('SELECT COALESCE(SUM(amount_minor),0) AS total FROM purchase_payments WHERE purchase_id=?').get(purchaseId).total;
    const due = purchase.total_minor - paid;
    if (payment.amountMinor > due) throw new Error('Payment exceeds the remaining supplier balance.');
    const id = randomUUID();
    db.prepare('INSERT INTO purchase_payments(id,purchase_id,method,amount_minor,reference,provider,occurred_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, purchaseId, payment.method, payment.amountMinor, payment.reference, payment.provider, payment.occurredAt);
    postJournalEntry({ sourceType: 'supplier_payment', sourceId: id,
      description: `Payment to supplier for ${purchase.invoice_number}`, occurredAt: payment.occurredAt,
      lines: [
        { accountId: 'acc-ap', debitMinor: payment.amountMinor },
        { accountId: paymentAccounts[payment.method], creditMinor: payment.amountMinor }
      ] });
    auditPayment(actorUserId, 'supplier.payment', id, { purchaseId, amountMinor: payment.amountMinor, method: payment.method });
    return { id, purchaseId, amountMinor: payment.amountMinor, remainingMinor: due - payment.amountMinor };
  });
}

export function listCustomerBalances() {
  return db.prepare(`
    SELECT c.id,c.name,c.phone,COALESCE(SUM(s.total_minor-COALESCE(p.paid_minor,0)),0) AS balanceMinor
    FROM customers c
    LEFT JOIN sales s ON s.customer_id=c.id AND s.status IN ('posted','partially_returned')
    LEFT JOIN (SELECT sale_id,SUM(amount_minor) AS paid_minor FROM payments WHERE direction='in' GROUP BY sale_id) p ON p.sale_id=s.id
    GROUP BY c.id ORDER BY c.name
  `).all();
}

export function listSupplierBalances() {
  return db.prepare(`
    SELECT s.id,s.name,s.phone,COALESCE(SUM(p.total_minor-COALESCE(pp.paid_minor,0)),0) AS balanceMinor
    FROM suppliers s
    LEFT JOIN purchases p ON p.supplier_id=s.id AND p.status='posted'
    LEFT JOIN (SELECT purchase_id,SUM(amount_minor) AS paid_minor FROM purchase_payments GROUP BY purchase_id) pp ON pp.purchase_id=p.id
    GROUP BY s.id ORDER BY s.name
  `).all();
}

export function getCustomerStatement(customerId) {
  const customer = db.prepare('SELECT id,name,phone FROM customers WHERE id=?').get(customerId);
  if (!customer) throw new Error('Customer not found.');
  const invoices = db.prepare(`
    SELECT s.id,s.receipt_number AS reference,s.occurred_at AS occurredAt,s.total_minor AS totalMinor,
      COALESCE(p.paid_minor,0) AS paidMinor,s.total_minor-COALESCE(p.paid_minor,0) AS dueMinor
    FROM sales s LEFT JOIN (SELECT sale_id,SUM(amount_minor) AS paid_minor FROM payments WHERE direction='in' GROUP BY sale_id) p ON p.sale_id=s.id
    WHERE s.customer_id=? AND s.status IN ('posted','partially_returned') ORDER BY s.occurred_at DESC
  `).all(customerId);
  return { party: customer, balanceMinor: invoices.reduce((sum,row)=>sum+row.dueMinor,0), invoices };
}

export function getSupplierStatement(supplierId) {
  const supplier = db.prepare('SELECT id,name,phone FROM suppliers WHERE id=?').get(supplierId);
  if (!supplier) throw new Error('Supplier not found.');
  const invoices = db.prepare(`
    SELECT p.id,p.invoice_number AS reference,p.occurred_at AS occurredAt,p.total_minor AS totalMinor,
      COALESCE(pp.paid_minor,0) AS paidMinor,p.total_minor-COALESCE(pp.paid_minor,0) AS dueMinor
    FROM purchases p LEFT JOIN (SELECT purchase_id,SUM(amount_minor) AS paid_minor FROM purchase_payments GROUP BY purchase_id) pp ON pp.purchase_id=p.id
    WHERE p.supplier_id=? AND p.status='posted' ORDER BY p.occurred_at DESC
  `).all(supplierId);
  return { party: supplier, balanceMinor: invoices.reduce((sum,row)=>sum+row.dueMinor,0), invoices };
}
