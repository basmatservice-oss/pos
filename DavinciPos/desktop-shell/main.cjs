const {app,BrowserWindow,dialog}=require('electron');
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const https=require('node:https');
const crypto=require('node:crypto');

let serverProcess=null,bootstrapToken=null;
const appRoot=app.getAppPath();
const runtimeRoot=appRoot.endsWith('.asar')?appRoot+'.unpacked':appRoot;
const userData=app.getPath('userData');
const lanConfigPath=path.join(userData,'lan-host.json');

function loadLanConfig(){
 try{
  const config=JSON.parse(fs.readFileSync(lanConfigPath,'utf8'));
  if(!config.enabled)return {enabled:false};
  for(const key of ['hostIp','certPath','keyPath','caPath']){
   if(typeof config[key]!=='string'||!config[key])throw new Error('Missing '+key+' in '+lanConfigPath);
  }
  for(const key of ['certPath','keyPath','caPath']){
   if(!fs.existsSync(config[key]))throw new Error('LAN certificate file not found: '+config[key]);
  }
  return {...config,enabled:true,port:Number(config.port||3187)};
 }catch(error){
  if(error.code==='ENOENT')return {enabled:false};
  throw error;
 }
}
const lanConfig=loadLanConfig();
const PORT=lanConfig.enabled?lanConfig.port:3187;
const HOST=lanConfig.enabled?lanConfig.hostIp:'127.0.0.1';
const BASE_URL=(lanConfig.enabled?'https://':'http://')+HOST+':'+PORT;

function tokenForFirstRun(){
 const file=path.join(userData,'bootstrap-token.txt');
 fs.mkdirSync(path.dirname(file),{recursive:true});
 if(fs.existsSync(file))return fs.readFileSync(file,'utf8').trim();
 const token=crypto.randomBytes(32).toString('base64url');
 fs.writeFileSync(file,token,{mode:0o600});return token;
}
function startServer(){
 bootstrapToken=tokenForFirstRun();
 const env={...process.env,ELECTRON_RUN_AS_NODE:'1',HOST,PORT:String(PORT),
  DAVINCIPOS_DB:path.join(userData,'DavinciPos.sqlite'),
  DAVINCIPOS_BOOTSTRAP_TOKEN:bootstrapToken};
 if(lanConfig.enabled){
  env.TLS_CERT_PATH=lanConfig.certPath;
  env.TLS_KEY_PATH=lanConfig.keyPath;
  env.NODE_EXTRA_CA_CERTS=lanConfig.caPath;
 }
 serverProcess=spawn(process.execPath,[path.join(runtimeRoot,'server.js')],{
  cwd:runtimeRoot,windowsHide:true,stdio:'ignore',env
 });
 serverProcess.on('error',e=>dialog.showErrorBox('DavinciPos server error',e.message));
}
function checkHealth(){
 return new Promise((resolve,reject)=>{
  const options=lanConfig.enabled?{ca:fs.readFileSync(lanConfig.caPath),rejectUnauthorized:true}:undefined;
  const request=httpsOrHttpGet(BASE_URL+'/api/health',options,(response)=>{
   let body='';
   response.setEncoding('utf8');
   response.on('data',chunk=>body+=chunk);
   response.on('end',()=>{
    try{if(response.statusCode!==200)return reject(new Error('Health check HTTP '+response.statusCode));resolve(JSON.parse(body));}
    catch(error){reject(error);}
   });
  });
  request.setTimeout(2500,()=>request.destroy(new Error('Health check timed out')));
  request.on('error',reject);
 });
}
function httpsOrHttpGet(url,options,callback){
 if(lanConfig.enabled)return https.get(url,options,callback);
 return require('node:http').get(url,callback);
}
async function waitForServer(){
 const until=Date.now()+45000;
 while(Date.now()<until){
  try{return await checkHealth();}catch{}
  await new Promise(resolve=>setTimeout(resolve,350));
 }
 throw new Error('The DavinciPos service did not start within 45 seconds. Check the LAN certificate configuration.');
}
async function createWindow(){
 const health=await waitForServer();
 if(health.bootstrapRequired){
  await dialog.showMessageBox({type:'info',title:'Initial DavinciPos setup',
   message:'Copy this one-time setup token and enter it on the first owner-account screen.',
   detail:bootstrapToken,buttons:['Continue']});
 }else{try{fs.unlinkSync(path.join(userData,'bootstrap-token.txt'));}catch{}}
 if(lanConfig.enabled){
  await dialog.showMessageBox({type:'info',title:'DavinciPos LAN host',
   message:'Secure local-network hosting is enabled. Connect cashier devices to the same LAN/Wi-Fi and open:',
   detail:BASE_URL+'/mobile',buttons:['Continue']});
 }
 const win=new BrowserWindow({width:1440,height:920,minWidth:980,minHeight:680,
  backgroundColor:'#101827',autoHideMenuBar:true,
  webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});
 await win.loadURL(BASE_URL+'/desktop');
}
app.whenReady().then(async()=>{startServer();try{await createWindow();}catch(e){dialog.showErrorBox('DavinciPos could not start',e.message);app.quit();}});
app.on('before-quit',()=>{if(serverProcess&&!serverProcess.killed)serverProcess.kill();serverProcess=null;});
app.on('window-all-closed',()=>app.quit());
