const labels = {dashboard:'نظرة عامة',sales:'نقطة البيع',inventory:'المخزون والمنتجات',purchases:'المشتريات',customers:'العملاء',accounting:'المحاسبة',reports:'التقارير',settings:'الإعدادات'};
const title = document.querySelector('#page-title');
const view = document.querySelector('#app-view');
document.querySelector('#today').textContent = new Intl.DateTimeFormat('ar', {dateStyle:'full'}).format(new Date());
async function loadSummary(){
  try{
    const response = await fetch('/api/summary');
    if(!response.ok) throw new Error('API unavailable');
    const {data} = await response.json();
    document.querySelector('#metric-products').textContent = data.products.toLocaleString('ar');
    document.querySelector('#metric-sales').textContent = data.salesCount.toLocaleString('ar');
    document.querySelector('#metric-total').textContent = (data.salesTotalMinor/100).toLocaleString('ar',{minimumFractionDigits:2});
  }catch{document.querySelector('#metric-products').textContent='—';}
}
function navigate(key){
  title.textContent = labels[key] || labels.dashboard;
  document.querySelectorAll('.nav-item').forEach(item=>item.classList.toggle('active',item.dataset.view===key));
  if(key==='dashboard'){location.reload();return;}
  view.innerHTML = `<div class="panel"><span class="eyebrow">DavinciPos / ${labels[key]}</span><h2>${labels[key]}</h2><p style="color:#7d899b">هذه الوحدة ضمن خطة البناء. سيتم ربطها بخدمات النظام وقاعدة SQLite دون تكرار منطق الأعمال.</p></div>`;
}
document.querySelector('#desktop-nav').addEventListener('click',event=>{const button=event.target.closest('[data-view]');if(button)navigate(button.dataset.view);});
document.addEventListener('click',event=>{const button=event.target.closest('[data-go]');if(button)navigate(button.dataset.go);});
loadSummary();
