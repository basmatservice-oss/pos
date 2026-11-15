const CACHE_NAME='davincipos-mobile-shell-v2';
const SHELL=[
  '/mobile',
  '/assets/mobile.css',
  '/assets/mobile.js',
  '/assets/client.js',
  '/assets/sync-client.js',
  '/assets/local-store.js',
  '/assets/offline-quote.js',
  '/assets/sale-id.js'
];

self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting()));
});

self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('davincipos-mobile-shell-')&&key!==CACHE_NAME).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));
});

self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET')return;
  const url=new URL(request.url);
  if(url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;
  const isShell=SHELL.includes(url.pathname);
  if(!isShell)return;
  if(request.mode==='navigate'){
    event.respondWith(fetch(request).then(response=>{
      if(response.ok){const copy=response.clone();caches.open(CACHE_NAME).then(cache=>cache.put('/mobile',copy));}
      return response;
    }).catch(()=>caches.match('/mobile').then(cached=>cached||Response.error())));
    return;
  }
  event.respondWith(caches.match(request).then(cached=>{
    const network=fetch(request).then(response=>{
      if(response.ok){const copy=response.clone();caches.open(CACHE_NAME).then(cache=>cache.put(request,copy));}
      return response;
    });
    return cached||network;
  }));
});
