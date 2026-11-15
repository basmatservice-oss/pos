import {api,ensureSession,renderSettings,renderUsers,renderConflicts,renderProducts,renderInventory,renderPeople,renderInvoices,renderReports,renderSaleCheckout,renderPurchaseEntry,renderServices,renderCurrency,renderExpenses,renderReturns,logout} from './client.js';
const views={dashboard:'الرئيسية',sales:'المبيعات',products:'المنتجات',inventory:'المخزون',customers:'العملاء',suppliers:'الموردون',reports:'التقارير',services:'الخدمات',currency:'سعر الصرف',expenses:'المصروفات',returns:'المرتجعات',settings:'الإعدادات',users:'المستخدمون',conflicts:'تعارضات المزامنة'};
const root=document.querySelector('#mobile-view');
if('serviceWorker' in navigator)navigator.serviceWorker.register('/service-worker.js',{scope:'/'}).catch(()=>{});
async function refresh(){
 try{const {data}=await api('/api/summary');document.querySelector('#mobile-products').textContent=data.products.toLocaleString('ar');document.querySelector('#mobile-sales').textContent=data.salesCount.toLocaleString('ar');}
 catch{document.querySelector('#mobile-products').textContent='—';}
}
async function show(key){
 document.querySelectorAll('.bottom-nav button').forEach(button=>button.classList.toggle('selected',button.dataset.view===key));
 if(key==='dashboard'){location.reload();return;}
 if(key==='settings'){await renderSettings(root);return;}
 if(key==='users'){await renderUsers(root);return;}
 if(key==='conflicts'){await renderConflicts(root);return;}
 if(key==='inventory'){await renderInventory(root);return;}
 if(key==='sales'){await renderSaleCheckout(root);return;}
 if(key==='purchases'){await renderPurchaseEntry(root);return;}
 if(key==='returns'){await renderReturns(root);return;}
 if(key==='products'){await renderProducts(root);return;}
 if(key==='customers'||key==='suppliers'){await renderPeople(root,key);return;}
 if(key==='reports'){await renderReports(root);return;}
 if(key==='services'){await renderServices(root);return;}
 if(key==='currency'){await renderCurrency(root);return;}
 if(key==='expenses'){await renderExpenses(root);return;}
 root.innerHTML=`<section class="panel"><small style="color:#7770dc">DAVINCIPOS / ${views[key]||'الوحدة'}</small><h2>${views[key]||'الوحدة'}</h2><p style="color:#8792a4;font-size:12px">هذه الوحدة قيد استكمال الربط بخدمات النظام.</p></section>`;
}
document.addEventListener('click',event=>{if(event.target.closest('[data-logout]')){logout();return;}const button=event.target.closest('[data-view]');if(button)show(button.dataset.view);});
if(await ensureSession())await refresh();
