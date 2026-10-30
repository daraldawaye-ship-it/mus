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


/* Offline application shell. Static build assets only: never cache API requests
 * or replay financial writes. The cached HTML is published only after all of
 * its build chunks have been stored successfully. */
const shellCache = "alraesy-static-offline-20261030-v5";
const staticAsset = /^\/assets\/[a-zA-Z0-9/_-]+\.(?:js|css|woff2?)$/;
const commerceModule = /^\/assets\/CommercePages-[a-zA-Z0-9_-]+\.js$/;
const financeModule = /^\/assets\/FinancePages-[a-zA-Z0-9_-]+\.js$/;
let warmingBundle = null;

function assertStaticResponse(path, response) {
  if (!response.ok) throw new Error("Static asset unavailable: " + path);
  const mime = response.headers.get("content-type") || "";
  if (path.endsWith(".js") && !mime.includes("javascript") ||
      path.endsWith(".css") && !mime.includes("css")) {
    throw new Error("Unexpected static content type: " + path);
  }
}

// Serialized across install, navigation and online notifications. Downloading
// only missing hashed URLs avoids repeatedly transferring the full app.
function warmCurrentBundle() {
  if (warmingBundle) return warmingBundle;
  warmingBundle = (async () => {
    const manifestResponse = await fetch("/offline-assets.json", {cache: "no-store"});
    if (!manifestResponse.ok) throw new Error("Offline manifest unavailable");
    const manifest = await manifestResponse.json();
    if (!Array.isArray(manifest)) throw new Error("Invalid offline manifest");
    const assets = [...new Set(manifest.filter(path =>
      typeof path === "string" && staticAsset.test(path)
    ))];
    // Both sales and purchases use CommercePages; receipts and payments use
    // FinancePages. Never declare the installed shell ready without both.
    if (!assets.some(path => commerceModule.test(path)) ||
        !assets.some(path => financeModule.test(path))) {
      throw new Error("Required invoice or voucher module missing");
    }
    const cache = await caches.open(shellCache);
    for (let offset = 0; offset < assets.length; offset += 6) {
      await Promise.all(assets.slice(offset, offset + 6).map(async path => {
        if (await cache.match(path)) return;
        const response = await fetch(path, {cache: "no-store"});
        assertStaticResponse(path, response);
        await cache.put(path, response);
      }));
    }
    const htmlResponse = await fetch("/", {cache: "no-store"});
    if (!htmlResponse.ok || !htmlResponse.headers.get("content-type")?.includes("text/html")) {
      throw new Error("Application HTML unavailable");
    }
    const html = await htmlResponse.clone().text();
    const entryAssets = [...html.matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/g)]
      .map(match => match[1]);
    if (!entryAssets.length || entryAssets.some(path => !assets.includes(path))) {
      throw new Error("HTML and static asset manifest do not match");
    }
    // Commit the shell last. A temporary network failure must leave the
    // previously complete offline HTML in place, not a newer broken entry.
    await cache.put("/", htmlResponse);
    await Promise.allSettled(["/site-icon.png", "/site.webmanifest"].map(path => cache.add(path)));
  })().finally(() => { warmingBundle = null; });
  return warmingBundle;
}

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    try {
      await warmCurrentBundle();
      await self.skipWaiting();
    } catch (error) {
      // A failed install must not replace a worker with a usable older bundle.
      await caches.delete(shellCache);
      throw error;
    }
  })());
});
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = (await caches.keys()).filter(key =>
      key.startsWith("alraesy-static-")).sort();
    // Older PWA windows may still request their own hashed module URLs.
    await Promise.all(keys.slice(0,-3).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener("message", event => {
  // The app asks for a bundle refresh when it starts or comes back online.
  // No private data, URL or user identity is transferred in this message.
  if (event.data?.type !== "alraesy:warm-static") return;
  event.waitUntil(warmCurrentBundle().catch(() => undefined));
});
self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (request.mode === "navigate") {
    // waitUntil must be registered while this event is still dispatching.
    event.waitUntil(warmCurrentBundle().catch(() => undefined));
    event.respondWith((async () => {
      try {
        const response = await fetch(request, {cache: "no-store"});
        // The network response is usable immediately online. Only the
        // separately verified warmup is allowed to replace cached HTML.
        return response;
      } catch {
        const shell = await caches.open(shellCache);
        return await shell.match("/") ||
          new Response("لا توجد نسخة محلية بعد", {status: 503});
      }
    })());
    return;
  }
  if (!url.pathname.startsWith("/assets/") &&
      !["/site-icon.png", "/site-icon-512.png", "/site.webmanifest"].includes(url.pathname))
    return;
  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok && (!url.pathname.startsWith("/assets/") ||
        (staticAsset.test(url.pathname) &&
         (!url.pathname.endsWith(".js") || (response.headers.get("content-type") || "").includes("javascript"))))) {
      const cache = await caches.open(shellCache);
      await cache.put(request, response.clone());
    }
    return response;
  })());
});
