const base=process.env.DAVINCIPOS_BASE_URL||'http://127.0.0.1:3187';
const verifyRestart=process.env.VERIFY_RESTART==='1';
async function request(path,{method='GET',body,token}={}){
  const response=await fetch(base+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const data=await response.json();
  if(!response.ok)throw new Error(method+' '+path+' failed '+response.status+': '+JSON.stringify(data));
  return data;
}
const health=(await request('/api/health'));
if(health.status!=='ok'||health.database!=='sqlite')throw new Error('Embedded backend health check failed.');
if(!verifyRestart){
  const token=process.env.DAVINCIPOS_BOOTSTRAP_TOKEN;
  if(!token)throw new Error('Bootstrap token was not supplied by the Android app.');
  await request('/api/auth/bootstrap',{method:'POST',body:{bootstrapToken:token,username:'android-owner',password:'DavinciPos-RC-2026!',displayName:'Android Test Owner'}});
}
const login=await request('/api/auth/login',{method:'POST',body:{username:'android-owner',password:'DavinciPos-RC-2026!'}});
const auth=login.data?.token;
if(!auth)throw new Error('Android owner login did not return a session.');
if(!verifyRestart){
  await request('/api/settings',{method:'PUT',token:auth,body:{settings:{'tax.enabled':false}}});
  const product=(await request('/api/products',{method:'POST',token:auth,body:{name:'Android RC Test Item',sku:'ANDROID-RC-001',baseUnitId:'unit-piece',costMinor:1000,salePriceMinor:3000,trackStock:true}})).data.id;
  const purchase=(await request('/api/purchases/receive',{method:'POST',token:auth,body:{lines:[{productId:product,quantity:10,unitCostMinor:1000}],payments:[{method:'cash',amountMinor:10000}]}})).data;
  if(!purchase?.id)throw new Error('Android local purchase did not post.');
  const sale=(await request('/api/sales/checkout',{method:'POST',token:auth,body:{id:'android-rc-sale-001',lines:[{itemId:product,quantity:2}],payments:[{method:'cash',amountMinor:6000}]}})).data;
  if(!sale?.id||sale.totalMinor!==6000)throw new Error('Android local sale totals did not reconcile.');
  const options=(await request('/api/returns/sales/'+sale.id+'/options',{token:auth})).data;
  const returned=(await request('/api/returns/sales/'+sale.id,{method:'POST',token:auth,body:{lines:[{saleLineId:options.lines[0].id,quantity:1}],refundMethod:'cash'}})).data;
  if(!returned?.id||returned.totalMinor!==3000)throw new Error('Android local FIFO return did not post.');
  const report=(await request('/api/reports/simple',{token:auth})).data;
  if(report.salesTotalMinor!==3000||report.cogsMinor!==1000)throw new Error('Android local financial report did not reconcile.');
  console.log(JSON.stringify({health,product,purchaseId:purchase.id,saleId:sale.id,returnId:returned.id,salesTotalMinor:report.salesTotalMinor,cogsMinor:report.cogsMinor}));
}else{
  const products=(await request('/api/products',{token:auth})).data;
  const sales=(await request('/api/sales',{token:auth})).data;
  if(!products.some(p=>p.sku==='ANDROID-RC-001'))throw new Error('Product did not persist after Android process restart.');
  if(!sales.some(s=>s.id==='android-rc-sale-001'))throw new Error('Sale did not persist after Android process restart.');
  console.log(JSON.stringify({restartPersistence:'passed',products:products.length,sales:sales.length}));
}
