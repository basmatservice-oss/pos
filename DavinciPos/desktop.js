import { api,ensureSession,renderSettings,renderUsers } from './client.js';
const labels={dashboard:'نظرة عامة',sales:'نقطة البيع',inventory:'المخزون والمنتجات',purchases:'المشتريات',customers:'العملاء',accounting:'المحاسبة',reports:'التقارير',settings:'الإعدادات',users:'المستخدمون والصلاحيات'};
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
 view.innerHTML=`<div class="panel"><span class="eyebrow">DavinciPos / ${labels[key]}</span><h2>${labels[key]}</h2><p style="color:#7d899b">هذه الوحدة قيد استكمال الربط بخدمات النظام.</p></div>`;
}
document.querySelector('#desktop-nav').addEventListener('click',event=>{const button=event.target.closest('[data-view]');if(button)navigate(button.dataset.view);});
document.addEventListener('click',event=>{const button=event.target.closest('[data-go]');if(button)navigate(button.dataset.go);});
if(await ensureSession())await loadSummary();
