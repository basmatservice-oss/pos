import { randomUUID } from 'node:crypto';
import { db,inTransaction,getDefaultBranchId } from './database.js';
import { postJournalEntry } from './accounting.js';
const accounts={cash:'acc-cash',card:'acc-card',bank:'acc-bank',wallet:'acc-wallet',other:'acc-other-clearing'};
const providers=new Set(['bankak','ocash','fawry','mycashy']);
export function createExpense(input,{userId=null,branchId=getDefaultBranchId()}={}){
 const category=String(input?.category||'').trim(),amount=Number(input?.amountMinor),method=input?.paymentMethod||'cash';
 if(!category||category.length>100)throw new Error('Enter a valid expense category.');
 if(!Number.isSafeInteger(amount)||amount<=0)throw new Error('Expense amount must be a positive integer in minor currency units.');
 if(!accounts[method])throw new Error('Invalid expense payment method.');
 const provider=input?.provider||null;
 if(method==='wallet'&&!providers.has(provider))throw new Error('Select Bankak, OCash, Fawry or MyCashy.');
 if(provider&&!providers.has(provider))throw new Error('Unsupported payment provider.');
 const occurredAt=input?.occurredAt?new Date(input.occurredAt).toISOString():new Date().toISOString();
 const id=randomUUID(),now=new Date().toISOString(),reference=input?.reference?String(input.reference).trim().slice(0,120):null,note=input?.note?String(input.note).trim().slice(0,500):null;
 return inTransaction(()=>{
  db.prepare('INSERT INTO expenses(id,branch_id,category,amount_minor,payment_method,provider,reference,note,occurred_at,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
   .run(id,branchId,category,amount,method,provider,reference,note,occurredAt,userId,now);
  postJournalEntry({sourceType:'expense',sourceId:id,description:'Expense: '+category,occurredAt,lines:[
   {accountId:'acc-expenses',debitMinor:amount},{accountId:accounts[method],creditMinor:amount}
  ]});
  db.prepare('INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,details,created_at) VALUES(?,?,?,?,?,?,?)')
   .run(randomUUID(),userId,'expense.create','expense',id,JSON.stringify({category,amountMinor:amount,paymentMethod:method,provider}),now);
  return {id,category,amountMinor:amount,paymentMethod:method,provider,reference,note,occurredAt};
 });
}
export function listExpenses({from=null,to=null,limit=200}={}){
 const clauses=[],params=[];
 if(from){clauses.push('e.occurred_at>=?');params.push(new Date(from+'T00:00:00').toISOString());}
 if(to){const d=new Date(to+'T00:00:00');d.setDate(d.getDate()+1);clauses.push('e.occurred_at<?');params.push(d.toISOString());}
 return db.prepare(`SELECT e.id,e.category,e.amount_minor AS amountMinor,e.payment_method AS paymentMethod,e.provider,e.reference,e.note,
 e.occurred_at AS occurredAt,u.display_name AS createdBy FROM expenses e LEFT JOIN users u ON u.id=e.created_by
 ${clauses.length?'WHERE '+clauses.join(' AND '):''} ORDER BY e.occurred_at DESC LIMIT ?`).all(...params,Math.max(1,Math.min(500,Number(limit)||200)));
}
