const TOKEN_KEY='davincipos-session-token';
export async function api(path,{method='GET',body,headers={}}={}) {
  const token=sessionStorage.getItem(TOKEN_KEY);
  const response=await fetch(path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{}),...headers},body:body?JSON.stringify(body):undefined});
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(result.error||'Request failed.');
  return result.data;
}
function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));}
export async function ensureSession() {
  if(sessionStorage.getItem(TOKEN_KEY)) {
    try{await api('/api/auth/me');return true;}catch{sessionStorage.removeItem(TOKEN_KEY);}
  }
  const health=await fetch('/api/health').then(r=>r.json());
  const overlay=document.createElement('div');overlay.style.cssText='position:fixed;inset:0;z-index:9999;background:#101827ee;display:grid;place-items:center;padding:20px;font-family:inherit';
  overlay.innerHTML=`<form id="auth-form" style="width:min(420px,100%);background:#fff;color:#182235;padding:28px;border-radius:18px;display:grid;gap:12px;box-shadow:0 24px 80px #0005">
    <h2 style="margin:0">DavinciPos</h2><p style="margin:0;color:#667085">${health.bootstrapRequired?'إنشاء حساب المالك الأول':'تسجيل الدخول إلى النظام'}</p>
    ${health.bootstrapRequired?'<label>رمز التهيئة <input name="bootstrapToken" required type="password" autocomplete="off"></label>':''}
    <label>اسم المستخدم <input name="username" required autocomplete="username" minlength="3"></label>
    ${health.bootstrapRequired?'<label>الاسم الظاهر <input name="displayName" required value="System Owner"></label>':''}
    <label>كلمة المرور <input name="password" required type="password" autocomplete="current-password" minlength="12"></label>
    <button style="border:0;border-radius:10px;padding:13px;background:#6157d9;color:#fff;font-weight:700;cursor:pointer">${health.bootstrapRequired?'إنشاء حساب المالك':'دخول'}</button><p id="auth-error" role="alert" style="color:#b42318;margin:0"></p>
  </form>`;
  document.body.append(overlay);
  overlay.querySelector('#auth-form').addEventListener('submit',async event=>{
    event.preventDefault();const form=new FormData(event.currentTarget),data=Object.fromEntries(form.entries());
    try{
      const result=health.bootstrapRequired?await fetch('/api/auth/bootstrap',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}).then(async r=>{const j=await r.json();if(!r.ok)throw new Error(j.error);return j.data;}):await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}).then(async r=>{const j=await r.json();if(!r.ok)throw new Error(j.error);return j.data;});
      sessionStorage.setItem(TOKEN_KEY,result.token);location.reload();
    }catch(error){overlay.querySelector('#auth-error').textContent=error.message;}
  });
  return false;
}
const settingFields=[
 ['tax.enabled','تفعيل الضريبة','checkbox'],
 ['tax.purchase_mode','معالجة ضريبة المشتريات','select',['recoverable','non_recoverable','disabled'],['قابلة للاسترداد','غير قابلة للاسترداد','تعطيل الضريبة على المشتريات']],
 ['tax.price_mode','طريقة عرض السعر','select',['exclusive','inclusive'],['السعر قبل الضريبة','السعر شامل الضريبة']],
 ['tax.default_profile_id','ملف الضريبة الافتراضي','taxProfile'],
 ['inventory.cost_method','طريقة تقييم المخزون','select',['weighted','fifo'],['متوسط التكلفة المرجح','الوارد أولاً يصرف أولاً']],
 ['sync.offline_sales','تفعيل مزامنة المبيعات غير المتصلة','checkbox'],
 ['sync.stock_conflict_policy','سياسة تعارض المخزون','select',['hold_for_review','reject_sale'],['تعليق العملية للمراجعة','رفض العملية']],
 ['currency.code','العملة الأساسية','text'],
 ['company.name','اسم المنشأة','text']
];
export async function renderSettings(root) {
  root.innerHTML='<section class="panel"><h2>الإعدادات المركزية</h2><p>تُحفظ هذه القيم في قاعدة بيانات السيرفر وتُطبق على جميع الأجهزة.</p><div id="settings-fields">جارٍ التحميل...</div><p id="settings-message" role="status"></p></section>';
  try{
    const [values,profiles]=await Promise.all([api('/api/settings'),api('/api/tax-profiles')]);
    const fields=root.querySelector('#settings-fields');
    fields.innerHTML=settingFields.map(([key,label,type,options,labels])=>{
      const value=values[key];
      if(type==='taxProfile')return `<label style="display:grid;gap:7px;padding:12px;border-bottom:1px solid #e7eaf0">ملف الضريبة الافتراضي<select data-setting="tax.default_profile_id"><option value="">استخدام الملف المعرّف كافتراضي</option>${profiles.map(profile=>`<option value="${escapeHtml(profile.id)}" ${value===profile.id?'selected':''}>${escapeHtml(profile.name)} · ${(profile.rateBps/100).toFixed(2)}%</option>`).join('')}</select></label>`;
      if(type==='checkbox')return `<label style="display:flex;align-items:center;gap:10px;padding:12px;border-bottom:1px solid #e7eaf0"><input type="checkbox" data-setting="${key}" ${value?'checked':''}> ${label}</label>`;
      if(type==='select')return `<label style="display:grid;gap:7px;padding:12px;border-bottom:1px solid #e7eaf0">${label}<select data-setting="${key}">${options.map((option,i)=>`<option value="${option}" ${value===option?'selected':''}>${labels[i]}</option>`).join('')}</select></label>`;
      return `<label style="display:grid;gap:7px;padding:12px;border-bottom:1px solid #e7eaf0">${label}<input data-setting="${key}" value="${escapeHtml(value)}" maxlength="120"></label>`;
    }).join('')+'<button id="save-settings" class="primary-button" style="margin-top:16px">حفظ الإعدادات على السيرفر</button><hr><h3>إدارة ملفات الضريبة</h3><form id="new-tax-profile" style="display:grid;gap:8px;max-width:520px"><input name="name" required placeholder="اسم الملف الضريبي"><input name="rateBps" required type="number" min="0" max="10000" placeholder="النسبة بالنقاط الأساسية (مثال 1500 = 15%)"><select name="priceMode"><option value="exclusive">غير شامل</option><option value="inclusive">شامل</option></select><label><input type="checkbox" name="isDefault"> تعيين كملف افتراضي</label><button class="primary-button">حفظ ملف الضريبة</button></form><div id="tax-profile-message"></div>'
    root.querySelector('#new-tax-profile').addEventListener('submit',async event=>{event.preventDefault();const form=new FormData(event.currentTarget);const body={name:form.get('name'),rateBps:Number(form.get('rateBps')),priceMode:form.get('priceMode'),isDefault:form.get('isDefault')==='on'};try{await api('/api/tax-profiles',{method:'POST',body});await renderSettings(root);}catch(error){root.querySelector('#tax-profile-message').textContent=error.message;}});
    root.querySelector('#save-settings').addEventListener('click',async()=>{
      const changes={};root.querySelectorAll('[data-setting]').forEach(input=>changes[input.dataset.setting]=input.type==='checkbox'?input.checked:input.value);
      try{await api('/api/settings',{method:'PUT',body:{settings:changes}});root.querySelector('#settings-message').textContent='تم حفظ الإعدادات المركزية.';}
      catch(error){root.querySelector('#settings-message').textContent=error.message;}
    });
  }catch(error){root.querySelector('#settings-fields').textContent=error.message;}
}
export async function renderUsers(root) {
  root.innerHTML='<section class="panel"><h2>المستخدمون والأدوار</h2><div id="users-content">جارٍ التحميل...</div></section>';
  try{
    const users=await api('/api/users');
    root.querySelector('#users-content').innerHTML=`<form id="new-user" style="display:grid;gap:10px;max-width:520px;margin-bottom:20px"><h3>إضافة مستخدم</h3><input name="username" placeholder="اسم المستخدم" required minlength="3"><input name="displayName" placeholder="الاسم الظاهر" required><input name="password" type="password" placeholder="كلمة مرور (12 حرفاً على الأقل)" required minlength="12"><select name="role"><option value="cashier">كاشير</option><option value="sales">مبيعات</option><option value="manager">مدير</option><option value="accountant">محاسب</option><option value="admin">مدير نظام</option></select><button class="primary-button">إنشاء المستخدم</button><p id="user-message"></p></form><h3>قائمة المستخدمين</h3><div>${users.map(user=>`<form class="user-role-form" data-user-id="${escapeHtml(user.id)}" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px;border-bottom:1px solid #e7eaf0"><span>${escapeHtml(user.displayName)} (${escapeHtml(user.username)})</span><select name="role"><option value="owner" ${user.role==='owner'?'selected':''}>owner</option><option value="admin" ${user.role==='admin'?'selected':''}>admin</option><option value="manager" ${user.role==='manager'?'selected':''}>manager</option><option value="cashier" ${user.role==='cashier'?'selected':''}>cashier</option><option value="accountant" ${user.role==='accountant'?'selected':''}>accountant</option><option value="sales" ${user.role==='sales'?'selected':''}>sales</option></select><label><input type="checkbox" name="active" ${user.isActive?'checked':''}> نشط</label><button>تحديث</button></form>`).join('')}</div><button id="edit-roles" class="primary-button" style="margin-top:16px">إدارة صلاحيات الأدوار</button><div id="role-editor"></div>`;
    root.querySelectorAll('.user-role-form').forEach(form=>form.addEventListener('submit',async event=>{event.preventDefault();const values=new FormData(form);try{await api('/api/users/'+encodeURIComponent(form.dataset.userId),{method:'PATCH',body:{role:values.get('role'),active:values.get('active')==='on'}});await renderUsers(root);}catch(error){root.querySelector('#user-message').textContent=error.message;}}));
    root.querySelector('#new-user').addEventListener('submit',async event=>{
      event.preventDefault();const body=Object.fromEntries(new FormData(event.currentTarget).entries());
      try{await api('/api/users',{method:'POST',body});await renderUsers(root);}catch(error){root.querySelector('#user-message').textContent=error.message;}
    });
    root.querySelector('#edit-roles').addEventListener('click',async()=>{
      const target=root.querySelector('#role-editor');
      try{
        const roles=await api('/api/roles'),catalog=['dashboard.read','products.read','products.write','inventory.read','inventory.write','sales.read','sales.create','sales.void','purchases.read','purchases.create','customers.read','customers.write','suppliers.read','suppliers.write','reports.read','accounting.read','accounting.reverse','settings.read','settings.update','users.read','users.manage','roles.manage','sync.conflicts.read','sync.conflicts.resolve'];
        target.innerHTML=`<h3>صلاحيات الأدوار</h3><select id="role-select">${roles.filter(r=>!['owner','admin'].includes(r.name)).map(r=>`<option value="${escapeHtml(r.name)}">${escapeHtml(r.name)}</option>`).join('')}</select><div id="permission-list"></div><button id="save-role" class="primary-button">حفظ الصلاحيات</button><p id="role-message"></p>`;
        const select=target.querySelector('#role-select');
        const load=()=>{const role=roles.find(r=>r.name===select.value),granted=(role?.permissions||'').split(',');target.querySelector('#permission-list').innerHTML=catalog.map(p=>`<label style="display:block;padding:6px"><input type="checkbox" value="${p}" ${granted.includes(p)?'checked':''}> ${p}</label>`).join('');};
        select.addEventListener('change',load);load();
        target.querySelector('#save-role').addEventListener('click',async()=>{
          const permissions=[...target.querySelectorAll('#permission-list input:checked')].map(input=>input.value);
          try{await api('/api/roles/'+encodeURIComponent(select.value)+'/permissions',{method:'PUT',body:{permissions}});target.querySelector('#role-message').textContent='تم حفظ الصلاحيات.';}
          catch(error){target.querySelector('#role-message').textContent=error.message;}
        });
      }catch(error){target.textContent=error.message;}
    });
  }catch(error){root.querySelector('#users-content').textContent=error.message;}
}

export async function renderConflicts(root) {
  root.innerHTML='<section class="panel"><h2>تعارضات مزامنة المخزون</h2><p>المبيعات التي وصلت من أجهزة غير متصلة ولم تعد كمياتها متاحة تُعلّق هنا. لا يتم اعتمادها تلقائياً على حساب رصيد مخزون سالب.</p><div id="conflict-list">جارٍ التحميل...</div></section>';
  const load=async()=>{
    try{
      const conflicts=await api('/api/sync/conflicts'),list=root.querySelector('#conflict-list');
      if(!conflicts.length){list.textContent='لا توجد تعارضات معلّقة.';return;}
      list.innerHTML=conflicts.map(item=>`<article style="padding:14px;border-bottom:1px solid #e7eaf0"><b>عملية ${escapeHtml(item.entityId)}</b><p>${escapeHtml(item.reason)}</p><small>الجهاز: ${escapeHtml(item.deviceId)} · ${escapeHtml(item.createdAt)}</small><div style="display:flex;gap:8px;margin-top:10px"><button data-conflict="${escapeHtml(item.id)}" data-decision="retry">إعادة المحاولة</button><button data-conflict="${escapeHtml(item.id)}" data-decision="reject">رفض العملية</button></div></article>`).join('');
      list.querySelectorAll('[data-conflict]').forEach(button=>button.addEventListener('click',async()=>{
        button.disabled=true;
        try{await api('/api/sync/conflicts/'+encodeURIComponent(button.dataset.conflict)+'/resolve',{method:'POST',body:{decision:button.dataset.decision}});await load();}
        catch(error){button.disabled=false;list.insertAdjacentHTML('afterbegin',`<p role="alert">${escapeHtml(error.message)}</p>`);}
      }));
    }catch(error){root.querySelector('#conflict-list').textContent=error.message;}
  };
  await load();
}
