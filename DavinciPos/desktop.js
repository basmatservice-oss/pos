import { api,ensureSession,renderSettings,renderUsers,renderConflicts,renderProducts,renderInventory,renderPeople,renderInvoices,renderAccounting,renderSaleCheckout,logout } from './client.js';
const labels={dashboard:'نظرة عامة',sales:'نقطة البيع',products:'المنتجات',inventory:'المخزون والتسويات',purchases:'المشتريات',customers:'العملاء',accounting:'المحاسبة',reports:'التقارير',settings:'الإعدادات',users:'المستخدمون والصلاحيات',conflicts:'تعارضات المزامنة'};
const title=document.querySelector('#page-title'),view=document.querySelector('#app-view');
document.querySelector('#today').textContent=new Intl.DateTimeFormat('ar',{dateStyle:'full'}).format(new Date());
async function loadSummary(){
 try{const {data}=await api('/api/summary');document.querySelector('#metric-products').textContent=data.products.toLocaleString('ar');document.querySelector('#metric-sales').textContent=data.salesCount.toLocaleString('ar');document.querySelector('#metric-total').textContent=(data.salesTotalMinor/100).toLocaleString('ar',{minimumFractionDigits:2});}
 catch{document.querySelector('#metric-products').textContent='—';}
}
async function navigate(key){
 title.textContent=labels[key]||labels.dashboard;
 document.querySelectorAll('.nav-item').forEach(item=>item.classList.toggle('active',item.dataset.view===key));
 if(key==='dashboard'){location.reload();return;}
 if(key==='settings'){await renderSettings(view);return;}
 if(key==='users'){await renderUsers(view);return;}
 if(key==='conflicts'){await renderConflicts(view);return;}
 if(key==='inventory'){await renderInventory(view);return;}
 if(key==='sales'){await renderSaleCheckout(view);return;}
 if(key==='purchases'){await renderInvoices(view,key);return;}
 if(key==='products'){await renderProducts(view);return;}
 if(key==='customers'||key==='suppliers'){await renderPeople(view,key);return;}
 if(key==='accounting'){await renderAccounting(view);return;}
 view.innerHTML=`<div class="panel"><span class="eyebrow">DavinciPos / ${labels[key]}</span><h2>${labels[key]}</h2><p style="color:#7d899b">هذه الوحدة قيد استكمال الربط بخدمات النظام.</p></div>`;
}
document.addEventListener('click',event=>{if(event.target.closest('[data-logout]'))logout();});
document.querySelector('#desktop-nav').addEventListener('click',event=>{const button=event.target.closest('[data-view]');if(button)navigate(button.dataset.view);});
document.addEventListener('click',event=>{const button=event.target.closest('[data-go]');if(button)navigate(button.dataset.go);});
if(await ensureSession())await loadSummary();
