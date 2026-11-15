const base=process.env.DAVINCIPOS_BASE_URL||'http://127.0.0.1:3187';
const verifyRestart=process.env.VERIFY_RESTART==='1';

async function request(path,{method='GET',body,token}={}){
  const response=await fetch(base+path,{
    method,
    headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},
    ...(body?{body:JSON.stringify(body)}:{})
  });
  const data=await response.json();
  if(!response.ok)throw new Error(method+' '+path+' failed '+response.status+': '+JSON.stringify(data));
  return data;
}

const health=await request('/api/health');
if(health.status!=='ok'||health.database!=='sqlite')throw new Error('Embedded Node/SQLite health check failed.');

if(!verifyRestart){
  const bootstrapToken=process.env.DAVINCIPOS_BOOTSTRAP_TOKEN;
  if(!bootstrapToken)throw new Error('Android app did not expose its first-run bootstrap token.');
  await request('/api/auth/bootstrap',{
    method:'POST',
    body:{bootstrapToken,username:'android-rc-owner',password:'DavinciPos-RC-2026!',displayName:'Android RC Test Owner'}
  });
}

const login=await request('/api/auth/login',{
  method:'POST',
  body:{username:'android-rc-owner',password:'DavinciPos-RC-2026!'}
});
const token=login.data?.token;
if(!token)throw new Error('Local owner authentication failed.');

if(!verifyRestart){
  const created=await request('/api/products',{
    method:'POST',
    token,
    body:{
      name:'Android RC Persistence Test',
      sku:'ANDROID-RC-PERSIST-001',
      baseUnitId:'unit-piece',
      costMinor:1250,
      salePriceMinor:2500,
      trackStock:true
    }
  });
  if(!created.data?.id)throw new Error('Could not create a local SQLite product.');
  console.log(JSON.stringify({health,createdProductId:created.data.id,firstLaunch:'passed'}));
}else{
  const products=await request('/api/products',{token});
  const productList=products.data||[];
  if(!productList.some(product=>product.sku==='ANDROID-RC-PERSIST-001')){
    throw new Error('SQLite product was not preserved after force-stop and process restart.');
  }
  console.log(JSON.stringify({health,restartPersistence:'passed',products:productList.length}));
}
