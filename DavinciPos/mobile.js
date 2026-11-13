const views={dashboard:'الرئيسية',sales:'المبيعات',inventory:'المخزون',customers:'العملاء',reports:'التقارير',settings:'الإعدادات'};
const root=document.querySelector('#mobile-view');
async function refresh(){
  try{const response=await fetch('/api/summary');const {data}=await response.json();document.querySelector('#mobile-products').textContent=data.products.toLocaleString('ar');document.querySelector('#mobile-sales').textContent=data.salesCount.toLocaleString('ar');}
  catch{document.querySelector('#mobile-products').textContent='—';}
}
function show(key){
  document.querySelectorAll('.bottom-nav button').forEach(button=>button.classList.toggle('selected',button.dataset.view===key));
  if(key==='dashboard'){location.reload();return;}
  root.innerHTML=`<section class="panel"><small style="color:#7770dc">DAVINCIPOS / ${views[key]||'الوحدة'}</small><h2>${views[key]||'الوحدة'}</h2><p style="color:#8792a4;font-size:12px">سيتم بناء هذه الوحدة بواجهة هاتف مستقلة مع استخدام نفس خدمات وقواعد النظام المشتركة.</p></section>`;
}
document.addEventListener('click',event=>{const button=event.target.closest('[data-view]');if(button)show(button.dataset.view);});
refresh();
