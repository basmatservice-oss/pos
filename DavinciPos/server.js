import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import https from 'node:https';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { initializeDatabase, db, getDefaultBranchId } from './database.js';
import { checkoutSale } from './sales.js';
import { receivePurchase } from './purchases.js';
import { getTrialBalance, reverseJournalEntry } from './accounting.js';
import { getSettings, updateSettings } from './settings.js';
import { initializeSecurity, createUser, verifyLogin, requireAuth, requirePermission, logoutToken, listUsers, setUserRole } from './security.js';
import { listTaxProfiles, saveTaxProfile } from './tax.js';
import { acceptOfflineSale, listSyncConflicts, resolveSyncConflict } from './offline.js';
import { createProduct, updateProduct, listProducts, createCategory, listCategories, createCustomer, listCustomers, createSupplier, listSuppliers, listSales, listPurchases } from './catalog.js';
import { adjustInventory } from './inventory.js';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const app=express();
app.disable('x-powered-by');
app.use((req,res,next)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Permissions-Policy','camera=(self), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  if(req.secure)res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains');
  next();
});
app.use(express.json({limit:'2mb'}));
initializeDatabase();
initializeSecurity();

const loginAttempts=new Map();
let bootstrapInProgress=false;
function loginRateLimit(req,res,next){
  const key=req.ip||req.socket.remoteAddress||'unknown',now=Date.now(),state=loginAttempts.get(key)||{count:0,resetAt:now+60000};
  if(now>state.resetAt){state.count=0;state.resetAt=now+60000;}
  if(state.count>=10)return res.status(429).json({error:'Too many login attempts. Try again in one minute.'});
  state.count++;loginAttempts.set(key,state);next();
}
function asyncRoute(handler){return (req,res,next)=>Promise.resolve(handler(req,res,next)).catch(next);}
const api=(permission,handler)=>[requireAuth,requirePermission(permission),handler];
const VALID_PERMISSIONS=new Set(['dashboard.read','products.read','products.write','inventory.read','inventory.write','sales.read','sales.create','sales.void','purchases.read','purchases.create','customers.read','customers.write','suppliers.read','suppliers.write','reports.read','accounting.read','accounting.reverse','settings.read','settings.update','users.read','users.manage','roles.manage','sync.conflicts.read','sync.conflicts.resolve']);

app.get('/api/health',(_req,res)=>res.json({status:'ok',database:'sqlite',version:2,bootstrapRequired:db.prepare('SELECT COUNT(*) AS count FROM users').get().count===0}));
app.post('/api/auth/bootstrap',loginRateLimit,asyncRoute(async(req,res)=>{
  if(bootstrapInProgress||db.prepare('SELECT COUNT(*) AS count FROM users').get().count!==0)return res.status(409).json({error:'Initial administrator already exists or setup is in progress.'});
  const expected=process.env.DAVINCIPOS_BOOTSTRAP_TOKEN,provided=req.body?.bootstrapToken;
  const expectedBuffer=Buffer.from(expected||''),providedBuffer=Buffer.from(typeof provided==='string'?provided:'');
  if(!expected||expectedBuffer.length!==providedBuffer.length||!timingSafeEqual(expectedBuffer,providedBuffer))return res.status(403).json({error:'A valid server bootstrap token is required.'});
  bootstrapInProgress=true;
  try{
    if(db.prepare('SELECT COUNT(*) AS count FROM users').get().count!==0)return res.status(409).json({error:'Initial administrator already exists.'});
    const user=await createUser({username:req.body.username,password:req.body.password,displayName:req.body.displayName||'System Owner',role:'owner'});
    const login=await verifyLogin(req.body.username,req.body.password);
    res.status(201).json({data:{...login,user}});
  }finally{bootstrapInProgress=false;}
}));
app.post('/api/auth/login',loginRateLimit,asyncRoute(async(req,res)=>{
  const login=await verifyLogin(req.body?.username,req.body?.password);
  if(!login)return res.status(401).json({error:'Invalid username or password.'});
  res.json({data:login});
}));
app.post('/api/auth/logout',requireAuth,(req,res)=>{
  const token=req.headers.authorization.slice(7);logoutToken(token);res.json({data:{loggedOut:true}});
});
app.get('/api/auth/me',requireAuth,(req,res)=>res.json({data:req.user}));

app.post('/api/devices/register',requireAuth,(req,res)=>{
  const {id,name,platform}=req.body||{};
  if(typeof id!=='string'||id.length<8||id.length>100||typeof name!=='string'||!name.trim()||!['desktop','android','web'].includes(platform))return res.status(400).json({error:'Invalid device registration.'});
  const existing=db.prepare('SELECT owner_user_id FROM devices WHERE id=?').get(id);
  if(existing&&existing.owner_user_id!==req.user.id)return res.status(409).json({error:'Device is already registered to another user.'});
  const branchId=getDefaultBranchId();
  const now=new Date().toISOString();
  db.prepare(`INSERT INTO devices(id,name,platform,branch_id,owner_user_id,is_active,last_seen_at,created_at)
    VALUES(?,?,?,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,platform=excluded.platform,branch_id=excluded.branch_id,last_seen_at=excluded.last_seen_at,is_active=1`)
    .run(id,name.trim(),platform,branchId||null,req.user.id,now,now);
  res.status(201).json({data:{id,name:name.trim(),platform,branchId:branchId||null}});
});
app.get('/api/settings',...api('settings.read',(req,res)=>res.json({data:getSettings()})));
app.put('/api/settings',...api('settings.update',(req,res)=>{
  try{res.json({data:updateSettings(req.body?.settings,{actorUserId:req.user.id})});}
  catch(error){res.status(400).json({error:error.message});}
}));
app.get('/api/users',...api('users.read',(_req,res)=>res.json({data:listUsers()})));
app.post('/api/users',...api('users.manage',asyncRoute(async(req,res)=>{
  const user=await createUser(req.body||{},req.user.id);res.status(201).json({data:user});
})));
app.patch('/api/users/:id',...api('users.manage',(req,res)=>{
  try{setUserRole(req.params.id,req.body?.role,req.body?.active!==false,req.user.id);res.json({data:{updated:true}});}
  catch(error){res.status(400).json({error:error.message});}
}));
app.put('/api/roles/:role/permissions',...api('roles.manage',(req,res)=>{
  const permissions=req.body?.permissions;
  if(!Array.isArray(permissions)||permissions.some(p=>typeof p!=='string'||!VALID_PERMISSIONS.has(p)))return res.status(400).json({error:'permissions contains an unsupported permission.'});
  if(['owner','admin'].includes(req.params.role))return res.status(400).json({error:'Built-in superuser roles cannot be restricted here.'});
  const exists=db.prepare('SELECT name FROM roles WHERE name=?').get(req.params.role);
  if(!exists)return res.status(404).json({error:'Role not found.'});
  const save=db.transaction(()=>{
    const previous=db.prepare('SELECT permission FROM role_permissions WHERE role_name=? ORDER BY permission').all(req.params.role).map(row=>row.permission);
    db.prepare('DELETE FROM role_permissions WHERE role_name=?').run(req.params.role);
    const insert=db.prepare('INSERT INTO role_permissions(role_name,permission) VALUES(?,?)');for(const p of permissions)insert.run(req.params.role,p);
    db.prepare('INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,details,created_at) VALUES(lower(hex(randomblob(16))),?,?,?,?,?,?)')
      .run(req.user.id,'role.permissions.update','role',req.params.role,JSON.stringify({previous,permissions}),new Date().toISOString());
  });
  try{save();res.json({data:{role:req.params.role,permissions}});}catch(error){res.status(400).json({error:error.message});}
}));
app.get('/api/roles',...api('users.read',(_req,res)=>res.json({data:db.prepare('SELECT r.name,r.description,group_concat(rp.permission) AS permissions FROM roles r LEFT JOIN role_permissions rp ON rp.role_name=r.name GROUP BY r.name ORDER BY r.name').all()})));

app.post('/api/sync/offline-sales',...api('sales.create',(req,res)=>{
  try{res.status(202).json({data:acceptOfflineSale({operationId:req.body?.operationId,deviceId:req.body?.deviceId,payload:req.body?.sale,userId:req.user.id})});}
  catch(error){res.status(400).json({error:error.message});}
}));
app.get('/api/sync/conflicts',...api('sync.conflicts.read',(_req,res)=>res.json({data:listSyncConflicts()})));
app.post('/api/sync/conflicts/:id/resolve',...api('sync.conflicts.resolve',(req,res)=>{
  try{res.json({data:resolveSyncConflict(req.params.id,{decision:req.body?.decision,userId:req.user.id})});}
  catch(error){res.status(400).json({error:error.message});}
}));

app.get('/api/tax-profiles',...api('settings.read',(_req,res)=>res.json({data:listTaxProfiles()})));
app.post('/api/tax-profiles',...api('settings.update',(req,res)=>{
  try{res.status(201).json({data:{id:saveTaxProfile(req.body||{})}});}catch(error){res.status(400).json({error:error.message});}
}));
app.get('/api/products',...api('products.read',(_req,res)=>res.json({data:listProducts(getDefaultBranchId())})));
app.post('/api/products',...api('products.write',(req,res)=>{try{res.status(201).json({data:{id:createProduct(req.body||{})}});}catch(error){res.status(400).json({error:error.message});}}));
app.patch('/api/products/:id',...api('products.write',(req,res)=>{try{updateProduct(req.params.id,req.body||{});res.json({data:{updated:true}});}catch(error){res.status(400).json({error:error.message});}}));
app.get('/api/categories',...api('products.read',(_req,res)=>res.json({data:listCategories()})));
app.post('/api/categories',...api('products.write',(req,res)=>{try{res.status(201).json({data:{id:createCategory(req.body||{})}});}catch(error){res.status(400).json({error:error.message});}}));
app.get('/api/customers',...api('customers.read',(_req,res)=>res.json({data:listCustomers()})));
app.post('/api/customers',...api('customers.write',(req,res)=>{try{res.status(201).json({data:{id:createCustomer(req.body||{})}});}catch(error){res.status(400).json({error:error.message});}}));
app.get('/api/suppliers',...api('suppliers.read',(_req,res)=>res.json({data:listSuppliers()})));
app.post('/api/suppliers',...api('suppliers.write',(req,res)=>{try{res.status(201).json({data:{id:createSupplier(req.body||{})}});}catch(error){res.status(400).json({error:error.message});}}));
app.get('/api/sales',...api('sales.read',(req,res)=>res.json({data:listSales({limit:req.query.limit})})));
app.get('/api/purchases',...api('purchases.read',(req,res)=>res.json({data:listPurchases({limit:req.query.limit})})));
app.post('/api/inventory/adjustments',...api('inventory.write',(req,res)=>{try{res.status(201).json({data:adjustInventory({...req.body,branchId:getDefaultBranchId(),userId:req.user.id})});}catch(error){res.status(400).json({error:error.message});}}));
app.post('/api/sales/checkout',...api('sales.create',(req,res)=>{
  try{const result=checkoutSale({...req.body,cashierId:req.user.id,branchId:getDefaultBranchId()});res.status(201).json({data:result});}
  catch(error){res.status(400).json({error:error.message||'Unable to complete sale.'});}
}));
app.post('/api/purchases/receive',...api('purchases.create',(req,res)=>{
  try{const result=receivePurchase({...req.body,branchId:getDefaultBranchId()});res.status(201).json({data:result});}
  catch(error){res.status(400).json({error:error.message||'Unable to receive purchase.'});}
}));
app.post('/api/accounting/journal-entries/:id/reverse',...api('accounting.reverse',(req,res)=>{
  try{const id=reverseJournalEntry(req.params.id,req.body?.reason||'Correction');res.json({data:{reversalEntryId:id}});}
  catch(error){res.status(400).json({error:error.message||'Unable to reverse journal entry.'});}
}));
app.get('/api/accounting/trial-balance',...api('accounting.read',(req,res)=>{
  try{res.json({data:getTrialBalance({from:req.query.from||null,to:req.query.to||null})});}
  catch(error){res.status(400).json({error:error.message||'Unable to build trial balance.'});}
}));
app.get('/api/summary',...api('dashboard.read',(_req,res)=>{
  const products=db.prepare('SELECT COUNT(*) AS count FROM products WHERE is_active=1').get().count;
  const sales=db.prepare("SELECT COUNT(*) AS count,COALESCE(SUM(total_minor),0) AS total FROM sales WHERE status='posted'").get();
  res.json({data:{products,salesCount:sales.count,salesTotalMinor:sales.total}});
}));

app.get('/desktop',(_req,res)=>res.sendFile(path.join(ROOT,'desktop.html')));
app.get('/mobile',(_req,res)=>res.sendFile(path.join(ROOT,'mobile.html')));
const publicAssets=new Set(['desktop.css','desktop.js','mobile.css','mobile.js','client.js']);
app.get('/assets/:asset',(req,res)=>{if(!publicAssets.has(req.params.asset))return res.sendStatus(404);res.sendFile(path.join(ROOT,req.params.asset));});
app.use((error,_req,res,_next)=>{res.status(500).json({error:'Internal server error.'});});

const port=Number(process.env.PORT||3000),host=process.env.HOST||'127.0.0.1';
if(!['127.0.0.1','localhost','::1'].includes(host)){
  const cert=process.env.TLS_CERT_PATH,key=process.env.TLS_KEY_PATH;
  if(!cert||!key||!fs.existsSync(cert)||!fs.existsSync(key))throw new Error('LAN binding requires TLS_CERT_PATH and TLS_KEY_PATH. Plain HTTP network access is blocked.');
  https.createServer({cert:fs.readFileSync(cert),key:fs.readFileSync(key)},app).listen(port,host,()=>console.log(`DavinciPos secure server listening on https://${host}:${port}`));
}else app.listen(port,host,()=>console.log(`DavinciPos listening on http://${host}:${port}`));
