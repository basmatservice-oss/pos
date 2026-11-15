export function calculateCachedSaleQuote({lines,snapshot,productUnits={}}){
  if(!Array.isArray(lines)||!lines.length)throw new Error('Offline quote requires at least one sale line.');
  if(!snapshot?.settings||!Array.isArray(snapshot.taxProfiles))throw new Error('Cached tax settings are unavailable; connect to the local server before selling.');
  const settings=snapshot.settings;
  const defaultProfile=snapshot.taxProfiles.find(profile=>profile.id===settings['tax.default_profile_id'])||snapshot.taxProfiles.find(profile=>profile.isDefault)||{rateBps:0,priceMode:settings['tax.price_mode']||'exclusive'};
  const enabled=settings['tax.enabled']!==false&&settings['tax.enabled']!=='false';
  const linesResult=lines.map(line=>{
    const quantity=Number(line.quantity);
    if(!Number.isFinite(quantity)||quantity<=0)throw new Error('Invalid offline sale quantity.');
    let item,unitPriceMinor;
    if((line.lineType||'product')==='service'){
      item=snapshot.services.find(value=>value.id===line.itemId&&value.isActive);
      if(!item)throw new Error('Service is not present in the cached catalogue.');
      unitPriceMinor=Number(item.priceMinor)+Number(item.componentSaleMinor||0);
    }else{
      item=snapshot.products.find(value=>value.id===line.itemId&&value.isActive);
      if(!item)throw new Error('Product is not present in the cached catalogue.');
      if(line.productUnitId){
        const unit=(productUnits[item.id]||[]).find(value=>value.id===line.productUnitId);
        if(!unit)throw new Error('Selected product unit is not cached on this device.');
        unitPriceMinor=unit.salePriceMinor==null?Math.round(Number(item.salePriceMinor)*Number(unit.baseQuantity)):Number(unit.salePriceMinor);
      }else unitPriceMinor=Number(item.salePriceMinor);
    }
    if(!Number.isSafeInteger(unitPriceMinor)||unitPriceMinor<0)throw new Error('Cached item price is invalid.');
    const exempt=Boolean(item.taxExempt);
    const rate=exempt?0:Number(item.taxRateBps)>0?Number(item.taxRateBps):Number(defaultProfile.rateBps||0);
    const mode=Number(item.taxRateBps)>0?(settings['tax.price_mode']||'exclusive'):(defaultProfile.priceMode||settings['tax.price_mode']||'exclusive');
    if(!['inclusive','exclusive'].includes(mode))throw new Error('Cached tax price mode is invalid.');
    const gross=Math.round(unitPriceMinor*quantity);
    const tax=enabled?(mode==='inclusive'?Math.round(gross*rate/(10000+rate)):Math.round(gross*rate/10000)):0;
    const net=enabled&&mode==='inclusive'?gross-tax:gross;
    return {itemId:line.itemId,quantity,netMinor:net,taxMinor:tax,totalMinor:net+tax,taxRateBps:enabled?rate:0,taxPriceMode:mode};
  });
  const subtotalMinor=linesResult.reduce((sum,line)=>sum+line.netMinor,0);
  const taxMinor=linesResult.reduce((sum,line)=>sum+line.taxMinor,0);
  const totalMinor=subtotalMinor+taxMinor;
  if(![subtotalMinor,taxMinor,totalMinor].every(Number.isSafeInteger))throw new Error('Offline quote exceeds safe monetary limits.');
  return {subtotalMinor,taxMinor,totalMinor,currencyCode:settings['currency.code']||'SDG',lines:linesResult,offlineEstimate:true};
}
