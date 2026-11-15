const {app,BrowserWindow,dialog}=require('electron');
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const PORT=3187,HOST='127.0.0.1';
let serverProcess=null,bootstrapToken=null;
const appRoot=app.getAppPath();
const runtimeRoot=appRoot.endsWith('.asar')?appRoot+'.unpacked':appRoot;
function tokenForFirstRun(){
 const file=path.join(app.getPath('userData'),'bootstrap-token.txt');
 fs.mkdirSync(path.dirname(file),{recursive:true});
 if(fs.existsSync(file))return fs.readFileSync(file,'utf8').trim();
 const token=crypto.randomBytes(32).toString('base64url');
 fs.writeFileSync(file,token,{mode:0o600});return token;
}
function startServer(){
 bootstrapToken=tokenForFirstRun();
 serverProcess=spawn(process.execPath,[path.join(runtimeRoot,'server.js')],{
  cwd:runtimeRoot,windowsHide:true,stdio:'ignore',
  env:{...process.env,ELECTRON_RUN_AS_NODE:'1',HOST,PORT:String(PORT),
   DAVINCIPOS_DB:path.join(app.getPath('userData'),'DavinciPos.sqlite'),
   DAVINCIPOS_BOOTSTRAP_TOKEN:bootstrapToken}
 });
 serverProcess.on('error',e=>dialog.showErrorBox('DavinciPos server error',e.message));
}
async function waitForServer(){
 const until=Date.now()+30000;
 while(Date.now()<until){
  try{const r=await fetch('http://'+HOST+':'+PORT+'/api/health');if(r.ok)return await r.json();}catch{}
  await new Promise(resolve=>setTimeout(resolve,350));
 }
 throw new Error('The local DavinciPos service did not start within 30 seconds.');
}
async function createWindow(){
 const health=await waitForServer();
 if(health.bootstrapRequired){
  await dialog.showMessageBox({type:'info',title:'Initial DavinciPos setup',
   message:'Copy this one-time setup token and enter it on the first owner-account screen.',
   detail:bootstrapToken,buttons:['Continue']});
 }else{try{fs.unlinkSync(path.join(app.getPath('userData'),'bootstrap-token.txt'));}catch{}}
 const win=new BrowserWindow({width:1440,height:920,minWidth:980,minHeight:680,
  backgroundColor:'#101827',autoHideMenuBar:true,
  webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});
 await win.loadURL('http://'+HOST+':'+PORT+'/desktop');
}
app.whenReady().then(async()=>{startServer();try{await createWindow();}catch(e){dialog.showErrorBox('DavinciPos could not start',e.message);app.quit();}});
app.on('before-quit',()=>{if(serverProcess&&!serverProcess.killed)serverProcess.kill();serverProcess=null;});
app.on('window-all-closed',()=>app.quit());
