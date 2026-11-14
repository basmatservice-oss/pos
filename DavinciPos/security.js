import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { db, inTransaction } from './database.js';
const scrypt=promisify(scryptCallback);
const SESSION_HOURS=12;
const ROLE_PERMISSIONS={
  owner:['*'],
  admin:['*'],
  manager:['dashboard.read','products.read','products.write','inventory.read','inventory.write','sales.read','sales.create','sales.credit','sales.collect','sales.void','purchases.read','purchases.create','purchases.pay','customers.read','customers.write','customers.balance.read','suppliers.read','suppliers.write','suppliers.balance.read','reports.read','expenses.read','expenses.create','accounting.read','settings.read','users.read','sync.conflicts.read','sync.conflicts.resolve'],
  cashier:['dashboard.read','products.read','inventory.read','sales.create','sales.collect','customers.read','customers.balance.read'],
  accountant:['dashboard.read','sales.read','sales.collect','purchases.read','purchases.pay','customers.balance.read','suppliers.balance.read','reports.read','expenses.read','accounting.read','accounting.reverse','settings.read'],
  sales:['dashboard.read','products.read','inventory.read','sales.read','sales.create','sales.collect','customers.read','customers.write','customers.balance.read']
};
export function initializeSecurity() {
  const insert=db.prepare('INSERT OR IGNORE INTO roles(name,description,is_system) VALUES(?,?,1)');
  const grant=db.prepare('INSERT OR IGNORE INTO role_permissions(role_name,permission) VALUES(?,?)');
  for(const [role,permissions] of Object.entries(ROLE_PERMISSIONS)) {
    const existed=db.prepare('SELECT name FROM roles WHERE name=?').get(role);
    insert.run(role,role+' role');
    if(!existed) for(const permission of permissions) grant.run(role,permission);
  }
  const permissionVersion=db.prepare("SELECT value FROM app_settings WHERE key='security.permissions.version'").get()?.value;
  if(permissionVersion!=='4') {
    for(const permission of ['sales.credit','expenses.read','expenses.create','sales.collect','purchases.pay','customers.balance.read','suppliers.balance.read'])grant.run('manager',permission);\n    for(const permission of ['sales.collect','customers.balance.read'])grant.run('cashier',permission);\n    for(const permission of ['sales.collect','purchases.pay','customers.balance.read','suppliers.balance.read'])grant.run('accountant',permission);\n    for(const permission of ['sales.collect','customers.balance.read'])grant.run('sales',permission);
    grant.run('accountant','expenses.read');
    db.prepare("INSERT INTO app_settings(key,value,updated_at) VALUES('security.permissions.version','4',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(new Date().toISOString());
  }
}
function passwordHash(password,salt) {
  return scrypt(password,salt,64).then(key=>key.toString('hex'));
}
export async function createUser({username,password,displayName,role='cashier'},actorUserId=null) {
  if(typeof username!=='string'||!/^[a-zA-Z0-9._-]{3,48}$/.test(username)) throw new Error('Username must be 3-48 characters using letters, numbers, dot, underscore or dash.');
  if(typeof password!=='string'||password.length<12||password.length>256) throw new Error('Password must contain at least 12 characters.');
  if(typeof displayName!=='string'||!displayName.trim()) throw new Error('Display name is required.');
  if(!ROLE_PERMISSIONS[role]) throw new Error('Invalid role.');
  if(role==='owner'&&actorUserId) { const actor=db.prepare('SELECT role FROM users WHERE id=?').get(actorUserId); if(actor?.role!=='owner') throw new Error('Only an owner can create another owner.'); }
  const salt=randomBytes(16).toString('hex'),hash=await passwordHash(password,salt),id=randomUUID(),now=new Date().toISOString();
  inTransaction(()=>{
    db.prepare('INSERT INTO users(id,username,password_hash,display_name,role,is_active,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)')
      .run(id,username.toLowerCase(),salt+':'+hash,displayName.trim(),role,now,now);
    db.prepare("INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,details,created_at) VALUES(?,?,'user.create','user',?,?,?)")
      .run(randomUUID(),actorUserId,id,JSON.stringify({username,role}),now);
  });
  return {id,username:username.toLowerCase(),displayName:displayName.trim(),role};
}
export async function verifyLogin(username,password) {
  const user=db.prepare('SELECT * FROM users WHERE username=? AND is_active=1').get(String(username||'').toLowerCase());
  if(!user||typeof password!=='string') return null;
  const [salt,stored]=user.password_hash.split(':');
  if(!salt||!stored) return null;
  const actual=await passwordHash(password,salt);
  const a=Buffer.from(actual,'hex'),b=Buffer.from(stored,'hex');
  if(a.length!==b.length||!timingSafeEqual(a,b)) return null;
  const token=randomBytes(32).toString('base64url'),tokenHash=createHash('sha256').update(token).digest('hex');
  const now=new Date(),expires=new Date(now.getTime()+SESSION_HOURS*3600000);
  db.prepare('DELETE FROM user_sessions WHERE expires_at<=?').run(now.toISOString());
  db.prepare('INSERT INTO user_sessions(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)')
    .run(randomUUID(),user.id,tokenHash,expires.toISOString(),now.toISOString());
  return {token,expiresAt:expires.toISOString(),user:{id:user.id,username:user.username,displayName:user.display_name,role:user.role}};
}
export function authenticateToken(token) {
  if(!token) return null;
  const hash=createHash('sha256').update(token).digest('hex');
  const row=db.prepare(`SELECT u.id,u.username,u.display_name,u.role FROM user_sessions s
    JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.is_active=1`).get(hash,new Date().toISOString());
  if(!row) return null;
  const permissions=db.prepare('SELECT permission FROM role_permissions WHERE role_name=?').all(row.role).map(r=>r.permission);
  return {id:row.id,username:row.username,displayName:row.display_name,role:row.role,permissions};
}
export function hasPermission(user,permission) {
  return Boolean(user&&(user.permissions.includes('*')||user.permissions.includes(permission)));
}
export function requireAuth(req,res,next) {
  const token=(req.headers.authorization||'').startsWith('Bearer ')?req.headers.authorization.slice(7):null;
  const user=authenticateToken(token);
  if(!user) return res.status(401).json({error:'Authentication required.'});
  req.user=user; next();
}
export function requirePermission(permission) {
  return (req,res,next)=>hasPermission(req.user,permission)?next():res.status(403).json({error:'Permission denied.'});
}
export function logoutToken(token) {
  if(!token) return 0;
  const hash=createHash('sha256').update(token).digest('hex');
  return db.prepare('DELETE FROM user_sessions WHERE token_hash=?').run(hash).changes;
}
export function listUsers() {
  return db.prepare('SELECT id,username,display_name AS displayName,role,is_active AS isActive,created_at AS createdAt FROM users ORDER BY username').all();
}
export function setUserRole(userId,role,active=true,actorUserId=null) {
  if(!ROLE_PERMISSIONS[role]) throw new Error('Invalid role.');
  if(role==='owner'&&actorUserId&&db.prepare('SELECT role FROM users WHERE id=?').get(actorUserId)?.role!=='owner') throw new Error('Only an owner can assign the owner role.');
  inTransaction(()=>{
    const target=db.prepare('SELECT role,is_active FROM users WHERE id=?').get(userId);
    if(!target) throw new Error('User not found.');
    const actorRole=actorUserId?db.prepare('SELECT role FROM users WHERE id=?').get(actorUserId)?.role:null;
    if(role==='owner'&&actorUserId&&actorRole!=='owner') throw new Error('Only an owner can assign the owner role.');
    if(target.role==='owner'&&actorUserId&&actorRole!=='owner') throw new Error('Only an owner can modify an owner account.');
    if(target.role==='owner'&&(!active||role!=='owner')) {
      const owners=db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='owner' AND is_active=1").get().count;
      if(owners<=1) throw new Error('The last active owner cannot be disabled or demoted.');
    }
    db.prepare('UPDATE users SET role=?,is_active=?,updated_at=? WHERE id=?').run(role,active?1:0,new Date().toISOString(),userId);
    db.prepare('INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,details,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(randomUUID(),actorUserId,'user.update','user',userId,JSON.stringify({role,active}),new Date().toISOString());
  });
  return true;
}
