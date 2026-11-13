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
    }).join('')+'<button id="save-settings" class="primary-button" style="margin-top:16px">حفظ الإعدادات على السيرفر</button><hr><h3>إدارة ملفات الضريبة</h3><form id="new-tax-profile" style="display:grid;gap:8px;max-width:520px"><input name="name" required placeholder="اسم الملف الضريبي"><input name="rateBps" required type="number" min="0" max="10000" placeholder="النسبة بالنقاط الأساسية (مثال 1500 = 15%)"><select name="priceMode"><option value="exclusive">غير شامل</option><option value="inclusive">شامل</option></select><label><input type="checkbox" name="isDefault"> تعيين كملف افتراضي</label><button class="primary-button">حفظ ملف الضريبة</button></form><div id="tax-profile-message"></div>';
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
        const roles=await api('/api/roles'),catalog=['dashboard.read','products.read','products.write','inventory.read','inventory.write','sales.read','sales.create','sales.credit','sales.void','purchases.read','purchases.create','customers.read','customers.write','suppliers.read','suppliers.write','reports.read','accounting.read','accounting.reverse','settings.read','settings.update','users.read','users.manage','roles.manage','sync.conflicts.read','sync.conflicts.resolve'];
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

export async function logout() {
  try { await api('/api/auth/logout',{method:'POST'}); } catch {}
  sessionStorage.removeItem(TOKEN_KEY);
  location.reload();
}

export async function renderProducts(root) {
  root.innerHTML='<section class="panel"><h2>المنتجات</h2><div id="product-area">جارٍ التحميل...</div></section>';
  try{
    const [products,categories,units]=await Promise.all([api('/api/products'),api('/api/categories'),api('/api/units')]);
    root.querySelector('#product-area').innerHTML=`<form id="product-form" style="display:grid;gap:8px;max-width:600px;margin-bottom:22px"><h3>إضافة منتج</h3><input name="name" required placeholder="اسم المنتج"><input name="sku" placeholder="SKU"><input name="barcode" placeholder="الباركود"><select name="baseUnitId">${units.map(u=>`<option value="${u.id}">${escapeHtml(u.name)} (${escapeHtml(u.symbol)})</option>`).join('')}</select><select name="categoryId"><option value="">بدون تصنيف</option>${categories.map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}</select><input name="costMinor" type="number" min="0" value="0" placeholder="التكلفة بوحدة العملة الصغرى"><input name="salePriceMinor" type="number" min="0" value="0" placeholder="سعر البيع بوحدة العملة الصغرى"><input name="taxRateBps" type="number" min="0" max="10000" value="0" placeholder="الضريبة بالنقاط الأساسية"><label><input name="taxExempt" type="checkbox"> معفى من الضريبة</label><label><input name="trackStock" type="checkbox" checked> تتبع المخزون</label><button class="primary-button">حفظ المنتج</button><p id="product-message"></p></form><h3>قائمة المنتجات</h3><div style="overflow:auto"><table><thead><tr><th>المنتج</th><th>SKU</th><th>المخزون</th><th>سعر البيع</th><th>الضريبة</th></tr></thead><tbody>${products.map(p=>`<tr><td>${escapeHtml(p.name)}</td><td>${escapeHtml(p.sku||'—')}</td><td>${Number(p.stockOnHand).toLocaleString('ar')}</td><td>${(p.salePriceMinor/100).toLocaleString('ar')}</td><td>${(p.taxRateBps/100).toFixed(2)}%</td></tr>`).join('')}</tbody></table></div>`;
    root.querySelector('#product-form').addEventListener('submit',async event=>{event.preventDefault();const f=new FormData(event.currentTarget);const body=Object.fromEntries(f.entries());body.costMinor=Number(body.costMinor);body.salePriceMinor=Number(body.salePriceMinor);body.taxRateBps=Number(body.taxRateBps);body.taxExempt=f.get('taxExempt')==='on';body.trackStock=f.get('trackStock')==='on';try{await api('/api/products',{method:'POST',body});await renderProducts(root);}catch(error){root.querySelector('#product-message').textContent=error.message;}});
  }catch(error){root.querySelector('#product-area').textContent=error.message;}
}
export async function renderInventory(root) {
  root.innerHTML='<section class="panel"><h2>المخزون والتسويات</h2><div id="inventory-area">جارٍ التحميل...</div></section>';
  try{
    const products=await api('/api/products');
    root.querySelector('#inventory-area').innerHTML=`<form id="adjustment-form" style="display:grid;gap:8px;max-width:520px;margin-bottom:20px"><h3>تسوية المخزون</h3><select name="productId">${products.map(p=>`<option value="${p.id}">${escapeHtml(p.name)} · الرصيد ${Number(p.stockOnHand).toLocaleString('ar')}</option>`).join('')}</select><input name="quantityDelta" type="number" step="0.001" required placeholder="الكمية (+ إضافة / - صرف)"><input name="unitCostMinor" type="number" min="0" value="0" placeholder="تكلفة الوحدة عند الإضافة"><input name="reason" required placeholder="سبب التسوية"><button class="primary-button">اعتماد التسوية</button><p id="adjustment-message"></p></form><h3>أرصدة المخزون</h3><div style="overflow:auto"><table><thead><tr><th>المنتج</th><th>الرصيد</th><th>حد التنبيه</th><th>قيمة المخزون</th></tr></thead><tbody>${products.map(p=>`<tr><td>${escapeHtml(p.name)}</td><td>${Number(p.stockOnHand).toLocaleString('ar')}</td><td>${Number(p.minStock).toLocaleString('ar')}</td><td>${(p.inventoryValueMinor/100).toLocaleString('ar')}</td></tr>`).join('')}</tbody></table></div>`;
    root.querySelector('#adjustment-form').addEventListener('submit',async event=>{event.preventDefault();const f=new FormData(event.currentTarget);const body=Object.fromEntries(f.entries());body.quantityDelta=Number(body.quantityDelta);body.unitCostMinor=Number(body.unitCostMinor);try{await api('/api/inventory/adjustments',{method:'POST',body});await renderInventory(root);}catch(error){root.querySelector('#adjustment-message').textContent=error.message;}});
  }catch(error){root.querySelector('#inventory-area').textContent=error.message;}
}
export async function renderPeople(root,kind) {
  const customers=kind==='customers',title=customers?'العملاء':'الموردون',endpoint=customers?'/api/customers':'/api/suppliers';
  root.innerHTML=`<section class="panel"><h2>${title}</h2><div id="people-area">جارٍ التحميل...</div></section>`;
  try{
    const records=await api(endpoint);
    root.querySelector('#people-area').innerHTML=`<form id="person-form" style="display:grid;gap:8px;max-width:520px;margin-bottom:20px"><h3>إضافة ${customers?'عميل':'مورد'}</h3><input name="name" required placeholder="الاسم"><input name="phone" placeholder="الهاتف"><input name="email" type="email" placeholder="البريد الإلكتروني">${customers?'':'<input name="address" placeholder="العنوان">'}<button class="primary-button">حفظ</button><p id="person-message"></p></form><div>${records.map(p=>`<div style="padding:10px;border-bottom:1px solid #e7eaf0"><b>${escapeHtml(p.name)}</b><small style="display:block;color:#8792a5">${escapeHtml(p.phone||p.email||'')}</small></div>`).join('')}</div>`;
    root.querySelector('#person-form').addEventListener('submit',async event=>{event.preventDefault();const body=Object.fromEntries(new FormData(event.currentTarget).entries());try{await api(endpoint,{method:'POST',body});await renderPeople(root,kind);}catch(error){root.querySelector('#person-message').textContent=error.message;}});
  }catch(error){root.querySelector('#people-area').textContent=error.message;}
}
export async function renderInvoices(root,kind) {
  const sales=kind==='sales',title=sales?'فواتير المبيعات':'فواتير المشتريات';
  root.innerHTML=`<section class="panel"><h2>${title}</h2><div id="invoice-area">جارٍ التحميل...</div></section>`;
  try{
    const rows=await api(sales?'/api/sales':'/api/purchases');
    root.querySelector('#invoice-area').innerHTML=rows.length?`<div style="overflow:auto"><table><thead><tr><th>الرقم</th><th>التاريخ</th><th>قبل الضريبة</th><th>الضريبة</th><th>الإجمالي</th><th>الحالة</th></tr></thead><tbody>${rows.map(row=>`<tr><td>${escapeHtml(sales?row.receiptNumber:row.invoiceNumber)}</td><td>${escapeHtml(row.occurredAt)}</td><td>${(row.subtotalMinor/100).toLocaleString('ar')}</td><td>${(row.taxMinor/100).toLocaleString('ar')}</td><td>${(row.totalMinor/100).toLocaleString('ar')}</td><td>${escapeHtml(row.status)}</td></tr>`).join('')}</tbody></table></div>`:'لا توجد فواتير حتى الآن.';
  }catch(error){root.querySelector('#invoice-area').textContent=error.message;}
}
export async function renderReports(root) {
  const today=new Date().toISOString().slice(0,10),monthStart=today.slice(0,8)+'01';
  root.innerHTML='<section class="panel"><h2>تقارير المتجر</h2><p>ملخص مبسط للمبيعات والمشتريات والربح التقريبي وتنبيهات المخزون.</p><div style="display:flex;gap:10px;flex-wrap:wrap;align-items:end;margin:14px 0"><label>من تاريخ<input id="report-from" type="date" value="'+monthStart+'"></label><label>إلى تاريخ<input id="report-to" type="date" value="'+today+'"></label><button id="report-load" class="primary-button">عرض التقرير</button></div><div id="report-area">جارٍ تحميل التقرير...</div></section>';
  const load=async()=>{const area=root.querySelector('#report-area');area.textContent='جارٍ تحميل التقرير...';try{const q=new URLSearchParams({from:root.querySelector('#report-from').value,to:root.querySelector('#report-to').value});const r=await api('/api/reports/simple?'+q);const money=n=>(Number(n||0)/100).toLocaleString('ar',{maximumFractionDigits:2});area.innerHTML='<div class="metric-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:12px"><article class="metric-card"><span>إجمالي المبيعات</span><strong>'+money(r.salesTotalMinor)+'</strong><small>'+r.salesCount.toLocaleString('ar')+' فاتورة</small></article><article class="metric-card"><span>إجمالي المشتريات</span><strong>'+money(r.purchasesTotalMinor)+'</strong><small>'+r.purchasesCount.toLocaleString('ar')+' فاتورة</small></article><article class="metric-card"><span>الربح التقريبي</span><strong>'+money(r.grossProfitMinor)+'</strong><small>المبيعات ناقص تكلفة البضاعة</small></article><article class="metric-card"><span>الضريبة المحصلة</span><strong>'+money(r.salesTaxMinor)+'</strong><small>ضمن فواتير المبيعات</small></article></div><h3 style="margin-top:22px">أكثر المنتجات مبيعاً</h3>'+(r.topProducts.length?'<div style="overflow:auto"><table><thead><tr><th>المنتج</th><th>الكمية</th><th>قيمة المبيعات</th></tr></thead><tbody>'+r.topProducts.map(p=>'<tr><td>'+escapeHtml(p.name)+'</td><td>'+Number(p.quantity).toLocaleString('ar')+'</td><td>'+money(p.totalMinor)+'</td></tr>').join('')+'</tbody></table></div>':'<p>لا توجد مبيعات في الفترة المحددة.</p>')+'<h3 style="margin-top:22px">منتجات قاربت على النفاد</h3>'+(r.lowStock.length?'<div style="overflow:auto"><table><thead><tr><th>المنتج</th><th>الرصيد</th><th>حد التنبيه</th></tr></thead><tbody>'+r.lowStock.map(p=>'<tr><td>'+escapeHtml(p.name)+'</td><td>'+Number(p.quantity).toLocaleString('ar')+'</td><td>'+Number(p.minStock).toLocaleString('ar')+'</td></tr>').join('')+'</tbody></table></div>':'<p>لا توجد منتجات تحت حد التنبيه.</p>');}catch(e){area.textContent=e.message;}};
  root.querySelector('#report-load').addEventListener('click',load);await load();
}

export async function renderSaleCheckout(root) {
  root.innerHTML='<section class="panel"><h2>نقطة البيع</h2><div id="pos-area">جارٍ التحميل...</div></section>';
  try{
    const [products,customers]=await Promise.all([api('/api/products'),api('/api/customers')]);
    const available=products.filter(p=>p.trackStock||Number(p.stockOnHand)>0);
    let cart=[];
    root.querySelector('#pos-area').innerHTML=`<div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px"><label>المنتج<select id="pos-product">${products.map(p=>`<option value="${p.id}">${escapeHtml(p.name)} · ${(p.salePriceMinor/100).toLocaleString('ar')} · الرصيد ${Number(p.stockOnHand).toLocaleString('ar')}</option>`).join('')}</select></label><label>الكمية<input id="pos-quantity" type="number" min="0.001" step="0.001" value="1"></label></div><button id="pos-add" class="primary-button" style="margin-top:12px">إضافة إلى الفاتورة</button><div id="pos-cart" style="margin-top:18px"></div><div style="display:grid;gap:8px;max-width:520px;margin-top:16px"><label>العميل (اختياري)<select id="pos-customer"><option value="">بيع نقدي مباشر</option>${customers.map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}</select></label><label>طريقة الدفع<select id="pos-method"><option value="cash">نقداً</option><option value="card">بطاقة</option><option value="bank">تحويل بنكي</option><option value="wallet">محفظة</option><option value="other">أخرى</option></select></label><button id="pos-checkout" class="primary-button">اعتماد البيع</button><p id="pos-message" role="status"></p></div>`;
    const quote=async()=>{
      if(!cart.length){root.querySelector('#pos-cart').textContent='أضف منتجاً للبدء.';return null;}
      const result=await api('/api/sales/quote',{method:'POST',body:{lines:cart}});
      root.querySelector('#pos-cart').innerHTML=`<h3>تفاصيل الفاتورة</h3><div style="overflow:auto"><table><thead><tr><th>الصنف</th><th>الكمية</th><th>الإجمالي</th><th></th></tr></thead><tbody>${cart.map((line,i)=>`<tr><td>${escapeHtml(line.description)}</td><td>${line.quantity}</td><td>${(result.lines[i].totalMinor/100).toLocaleString('ar')}</td><td><button data-remove="${i}">حذف</button></td></tr>`).join('')}</tbody></table></div><p>قبل الضريبة: ${(result.subtotalMinor/100).toLocaleString('ar')} · الضريبة: ${(result.taxMinor/100).toLocaleString('ar')}</p><h3>الإجمالي: ${(result.totalMinor/100).toLocaleString('ar')} ${escapeHtml(result.currencyCode)}</h3>`;
      root.querySelectorAll('[data-remove]').forEach(button=>button.addEventListener('click',async()=>{cart.splice(Number(button.dataset.remove),1);await quote();}));
      return result;
    };
    root.querySelector('#pos-add').addEventListener('click',async()=>{
      const product=products.find(p=>p.id===root.querySelector('#pos-product').value),quantity=Number(root.querySelector('#pos-quantity').value);
      if(!product||!Number.isFinite(quantity)||quantity<=0){root.querySelector('#pos-message').textContent='اختر منتجاً وأدخل كمية صحيحة.';return;}
      if(product.trackStock&&quantity>Number(product.stockOnHand)){root.querySelector('#pos-message').textContent='الكمية المطلوبة أكبر من الرصيد المتاح حالياً.';return;}
      cart.push({lineType:'product',itemId:product.id,description:product.name,quantity,baseQuantity:quantity,unitName:product.baseUnitSymbol||'pc',unitPriceMinor:product.salePriceMinor,trackStock:Boolean(product.trackStock)});
      root.querySelector('#pos-message').textContent='';await quote();
    });
    root.querySelector('#pos-checkout').addEventListener('click',async()=>{
      try{
        const totals=await quote();if(!totals)return;
        const customerId=root.querySelector('#pos-customer').value||null;
        const sale=await api('/api/sales/checkout',{method:'POST',body:{lines:cart,customerId,payments:[{method:root.querySelector('#pos-method').value,amountMinor:totals.totalMinor}]}});
        root.querySelector('#pos-message').textContent=`تم تسجيل الفاتورة ${sale.receiptNumber} · الإجمالي ${(sale.totalMinor/100).toLocaleString('ar')}`;
        cart=[];await quote();
      }catch(error){root.querySelector('#pos-message').textContent=error.message;}
    });
    await quote();
  }catch(error){root.querySelector('#pos-area').textContent=error.message;}
}

export async function renderPurchaseEntry(root) {
  root.innerHTML='<section class="panel"><h2>استلام مشتريات</h2><div id="purchase-area">جارٍ التحميل...</div></section>';
  try{
    const [products,suppliers]=await Promise.all([api('/api/products'),api('/api/suppliers')]);
    let cart=[];
    root.querySelector('#purchase-area').innerHTML=`<div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px"><label>المنتج<select id="purchase-product">${products.map(p=>`<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}</select></label><label>الكمية<input id="purchase-quantity" type="number" min="0.001" step="0.001" value="1"></label><label>تكلفة الوحدة<input id="purchase-cost" type="number" min="0" value="0"></label><label>المورد<select id="purchase-supplier"><option value="">بدون مورد</option>${suppliers.map(s=>`<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')}</select></label></div><button id="purchase-add" class="primary-button" style="margin-top:12px">إضافة الصنف</button><div id="purchase-cart" style="margin-top:16px"></div><div style="max-width:520px;display:grid;gap:8px;margin-top:16px"><label>طريقة الدفع<select id="purchase-method"><option value="cash">نقداً</option><option value="bank">تحويل بنكي</option><option value="card">بطاقة</option><option value="wallet">محفظة</option><option value="other">أخرى</option></select></label><button id="purchase-submit" class="primary-button">اعتماد استلام المشتريات</button><p id="purchase-message"></p></div>`;
    const quote=async()=>{
      if(!cart.length){root.querySelector('#purchase-cart').textContent='أضف صنفاً للبدء.';return null;}
      const result=await api('/api/purchases/quote',{method:'POST',body:{lines:cart}});
      root.querySelector('#purchase-cart').innerHTML=`<div style="overflow:auto"><table><thead><tr><th>الصنف</th><th>الكمية</th><th>الإجمالي</th><th></th></tr></thead><tbody>${cart.map((line,i)=>`<tr><td>${escapeHtml(line.productName)}</td><td>${line.quantity}</td><td>${(result.lines[i].totalMinor/100).toLocaleString('ar')}</td><td><button data-purchase-remove="${i}">حذف</button></td></tr>`).join('')}</tbody></table></div><p>قبل الضريبة: ${(result.subtotalMinor/100).toLocaleString('ar')} · الضريبة: ${(result.taxMinor/100).toLocaleString('ar')}</p><h3>الإجمالي: ${(result.totalMinor/100).toLocaleString('ar')} ${escapeHtml(result.currencyCode)}</h3><small>معالجة ضريبة المشتريات: ${escapeHtml(result.taxTreatment)}</small>`;
      root.querySelectorAll('[data-purchase-remove]').forEach(button=>button.addEventListener('click',async()=>{cart.splice(Number(button.dataset.purchaseRemove),1);await quote();}));
      return result;
    };
    root.querySelector('#purchase-add').addEventListener('click',async()=>{
      const product=products.find(p=>p.id===root.querySelector('#purchase-product').value),quantity=Number(root.querySelector('#purchase-quantity').value),unitCostMinor=Number(root.querySelector('#purchase-cost').value);
      if(!product||!Number.isFinite(quantity)||quantity<=0||!Number.isSafeInteger(unitCostMinor)||unitCostMinor<0){root.querySelector('#purchase-message').textContent='أدخل بيانات صنف صحيحة.';return;}
      cart.push({productId:product.id,productName:product.name,quantity,baseQuantity:quantity,unitName:product.baseUnitSymbol||'pc',unitCostMinor});
      root.querySelector('#purchase-message').textContent='';await quote();
    });
    root.querySelector('#purchase-submit').addEventListener('click',async()=>{
      try{
        const totals=await quote();if(!totals)return;
        const purchase=await api('/api/purchases/receive',{method:'POST',body:{supplierId:root.querySelector('#purchase-supplier').value||null,lines:cart,payments:[{method:root.querySelector('#purchase-method').value,amountMinor:totals.totalMinor}]}});
        root.querySelector('#purchase-message').textContent=`تم استلام الفاتورة ${purchase.invoiceNumber} · الإجمالي ${(purchase.totalMinor/100).toLocaleString('ar')}`;
        cart=[];await quote();
      }catch(error){root.querySelector('#purchase-message').textContent=error.message;}
    });
    await quote();
  }catch(error){root.querySelector('#purchase-area').textContent=error.message;}
}
