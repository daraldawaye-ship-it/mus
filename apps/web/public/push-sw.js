/* Web Push only. Never cache, intercept or replay accounting API requests. */
self.addEventListener("push", event => {
  let payload={};
  try { payload=event.data ? event.data.json() : {}; } catch { payload={}; }
  const title=typeof payload.title==="string" ? payload.title.slice(0,100) : "الرئيسي | Alraesy";
  const body=typeof payload.body==="string" ? payload.body.slice(0,200) : "لديك إشعار جديد";
  const url=typeof payload.url==="string" && /^\/(?!\/)/.test(payload.url)
    ? payload.url : "/notifications";
  const id=Number.isSafeInteger(payload.id) && payload.id>0 ? payload.id : null;
  const importance=["low","medium","high","critical"].includes(payload.importance)
    ? payload.importance : "medium";
  const urgent=importance==="critical" || importance==="high";
  event.waitUntil(Promise.all([
    self.registration.showNotification(title,{
      body,icon:"/site-icon.png",badge:"/site-icon.png",
      tag:"alraesy-notification-"+String(id??"new"),data:{url},
      dir:"rtl",lang:"ar",silent:false,
      // Android may use vibration for alerting notifications; the OS controls
      // actual sound and heads-up display, and may ignore these preferences.
      vibrate:urgent ? [220,100,220,100,300] : [180,100,180],
    }),
    // Ask foreground tabs to refetch their authenticated inbox. Do not send
    // notification text to tabs potentially signed in as a different user.
    self.clients.matchAll({type:"window",includeUncontrolled:true}).then(clients=>
      Promise.all(clients.map(client=>
        client.postMessage({type:"alraesy:push-notification",id})
      ))
    ),
  ]));
});
self.addEventListener("notificationclick",event=>{
  event.notification.close();
  const path=event.notification.data?.url??"/notifications";
  const target=new URL(path,self.location.origin);
  if(target.origin!==self.location.origin)return;
  event.waitUntil((async()=>{
    const clients=await self.clients.matchAll({type:"window",includeUncontrolled:true});
    for(const client of clients){
      if(new URL(client.url).origin===self.location.origin){
        await client.navigate(target.href);
        return client.focus();
      }
    }
    return self.clients.openWindow(target.href);
  })());
});


/* Offline application shell. Only versioned static files are cached here;
 * API responses and financial documents are NEVER stored by the worker. */
const shellCache = "alraesy-static-offline-20261030-v1";
self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(shellCache);
    await cache.addAll(["/", "/site-icon.png", "/site.webmanifest"]);
    try {
      const result = await fetch("/offline-assets.json", {cache: "no-store"});
      if (result.ok) {
        const resources = await result.json();
        if (Array.isArray(resources)) {
          await Promise.allSettled(resources.filter(path =>
            typeof path === "string" && /^\/assets\/[a-zA-Z0-9/_-]+\.(?:js|css|woff2?)$/.test(path)
          ).map(path => cache.add(path)));
        }
      }
    } catch { /* The shell remains usable; missing chunks need a later visit. */ }
    await self.skipWaiting();
  })());
});
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith("alraesy-static-") && key !== shellCache)
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        return response;
      } catch {
        return await caches.match("/") ||
          new Response("لا توجد نسخة محلية بعد", {status: 503});
      }
    })());
    return;
  }
  if (!url.pathname.startsWith("/assets/") && !["/site-icon.png", "/site-icon-512.png", "/site.webmanifest"].includes(url.pathname))
    return;
  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(shellCache);
      await cache.put(request, response.clone());
    }
    return response;
  })());
});
