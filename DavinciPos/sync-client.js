import {IndexedDbLocalStore} from './local-store.js';

export const localStore=globalThis.indexedDB?new IndexedDbLocalStore():null;

function createId(cryptoProvider=globalThis.crypto){
  if(cryptoProvider?.randomUUID)return cryptoProvider.randomUUID();
  if(!cryptoProvider?.getRandomValues)throw new Error('Secure random ID generation is unavailable.');
  const bytes=new Uint8Array(16);cryptoProvider.getRandomValues(bytes);
  return [...bytes].map(value=>value.toString(16).padStart(2,'0')).join('');
}

export async function getLocalDeviceId(store=localStore,cryptoProvider=globalThis.crypto){
  if(!store)throw new Error('Persistent local storage is unavailable on this device.');
  let id=await store.getMetadata('device-id');
  if(!id){id=createId(cryptoProvider);await store.setMetadata('device-id',id);}
  return id;
}

export async function registerLocalDevice(api,{store=localStore,name=globalThis.navigator?.userAgent||'DavinciPos terminal',platform='web'}={}){
  const deviceId=await getLocalDeviceId(store);
  await api('/api/devices/register',{method:'POST',body:{id:deviceId,name:String(name).slice(0,160),platform}});
  await store.setMetadata('device-registration',{deviceId,registeredAt:new Date().toISOString()});
  return deviceId;
}

export async function cachePosSnapshot(snapshot,store=localStore){
  if(!store)throw new Error('Persistent local storage is unavailable on this device.');
  if(!snapshot||typeof snapshot!=='object'||!Array.isArray(snapshot.products)||!Array.isArray(snapshot.customers)||!Array.isArray(snapshot.services))
    throw new Error('POS snapshot must contain products, customers and services.');
  await store.setMetadata('pos-snapshot',snapshot);
  return snapshot;
}

export async function loadPosSnapshot(store=localStore){
  if(!store)throw new Error('Persistent local storage is unavailable on this device.');
  return store.getMetadata('pos-snapshot');
}

export async function queueOfflineSale({sale,deviceId,store=localStore,operationId=createId()}){
  if(!store)throw new Error('Persistent local storage is unavailable on this device.');
  if(!deviceId)throw new Error('Device identity is required before queuing an offline sale.');
  return store.enqueueSale({sale,deviceId,operationId});
}

export async function synchronizePendingSales({api,store=localStore,deviceId=null}){
  if(!store)throw new Error('Persistent local storage is unavailable on this device.');
  if(typeof api!=='function')throw new Error('Authenticated API function is required.');
  const pending=await store.listPending({deviceId,limit:100});
  const results=[];
  for(const operation of pending){
    try{
      const response=await api('/api/sync/offline-sales',{method:'POST',body:{
        operationId:operation.operationId,deviceId:operation.deviceId,sale:operation.payload
      }});
      if(response.status==='conflict')await store.holdConflict(operation.operationId,response);
      else if(response.status==='rejected')await store.rejectOperation(operation.operationId,response);
      else await store.acknowledge(operation.operationId,response);
      results.push({operationId:operation.operationId,status:response.status||'accepted'});
    }catch(error){
      if(Number(error.status)>=400&&Number(error.status)<500&&error.status!==408&&error.status!==429){
        await store.rejectOperation(operation.operationId,{reason:error.message,statusCode:error.status});
        results.push({operationId:operation.operationId,status:'rejected',error:error.message});
        continue;
      }
      await store.recordFailure(operation.operationId,error.message);
      results.push({operationId:operation.operationId,status:'failed',error:error.message});
      break;
    }
  }
  return results;
}
