// Sale IDs are idempotency identifiers, not authentication secrets.
// Prefer the platform CSPRNG, but retain LAN HTTP compatibility on browsers
// where randomUUID/getRandomValues are unavailable outside secure contexts.
export function createSaleId({
  cryptoImpl=globalThis.crypto,
  now=Date.now,
  random=Math.random
}={}){
  if(typeof cryptoImpl?.randomUUID==='function')return cryptoImpl.randomUUID();
  const bytes=new Uint8Array(16);
  if(typeof cryptoImpl?.getRandomValues==='function'){
    cryptoImpl.getRandomValues(bytes);
  }else{
    for(let index=0;index<bytes.length;index++)bytes[index]=Math.floor(random()*256);
  }
  bytes[6]=(bytes[6]&0x0f)|0x40;
  bytes[8]=(bytes[8]&0x3f)|0x80;
  const hex=Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');
  return `sale-${Number(now()).toString(36)}-${hex}`;
}
