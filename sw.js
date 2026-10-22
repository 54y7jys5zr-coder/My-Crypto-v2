/* Service worker: offline app shell. Prices/FX are always fetched live (never cached here). */
const CACHE = "portfolio-v31";
const SHELL = [
  "./","./index.html","./styles.css","./app.js","./engine.js","./theme.js","./data.json",
  "./chart.umd.min.js","./manifest.webmanifest",
  "./icons/icon-192.png","./icons/icon-512.png","./icons/icon-maskable-512.png"
];
const NET_TIMEOUT_MS = 3000;   // slow network: fall back to the cached shell instead of hanging

const CORE = new Set(["./","./index.html","./styles.css","./app.js","./engine.js","./theme.js","./chart.umd.min.js"]);
self.addEventListener("install", e=>{
  // the app shell must cache; optional files (icons, data, manifest) are cached individually so
  // one missing file can't block the install and leave the app without offline support
  e.waitUntil(caches.open(CACHE).then(async c=>{
    await c.addAll([...CORE]);
    await Promise.allSettled(SHELL.filter(u=>!CORE.has(u)).map(u=>c.add(u)));
  }).then(()=>self.skipWaiting()));
});
self.addEventListener("activate", e=>{
  e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
/* notification tap: focus the open app (or open it) */
self.addEventListener("notificationclick", e=>{
  e.notification.close();
  e.waitUntil(self.clients.matchAll({type:"window"}).then(cs=>cs.length ? cs[0].focus() : self.clients.openWindow("./")));
});
self.addEventListener("fetch", e=>{
  const req=e.request;
  // only same-origin GETs are app shell; everything else (APIs, logos) goes straight to the network
  if(req.method!=="GET" || new URL(req.url).origin!==self.location.origin) return;
  // network-first with a timeout, cache fallback: online = fresh, offline/slow = cached
  e.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    const net=fetch(req).then(resp=>{ if(resp.status===200) cache.put(req,resp.clone()); return resp; });
    net.catch(()=>{});                                        // a late failure after a cache hit is fine
    const timeout=new Promise(res=>setTimeout(res,NET_TIMEOUT_MS));
    try{
      const first=await Promise.race([net,timeout]);
      if(first) return first;
      const cached=await cache.match(req, {ignoreSearch:true});
      return cached || await net;                            // nothing cached: keep waiting for the network
    }catch(err){
      return (await cache.match(req, {ignoreSearch:true})) || (await cache.match("./index.html")) || Response.error();
    }
  })());
});
