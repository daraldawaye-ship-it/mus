/* Web Push only. Never cache, intercept or replay accounting API requests. */
self.addEventListener("push", event => {
  let payload={};
  try { payload=event.data ? event.data.json() : {}; } catch { payload={}; }
  const title=typeof payload.title==="string" ? payload.title.slice(0,100) : "الرئيسي | Alraesy";
  const body=typeof payload.body==="string" ? payload.body.slice(0,200) : "لديك إشعار جديد";
  const url=typeof payload.url==="string" && /^\/(?!\/)/.test(payload.url)
    ? payload.url : "/notifications";
  event.waitUntil(self.registration.showNotification(title,{
    body,icon:"/site-icon.png",badge:"/site-icon.png",
    tag:"alraesy-notification-"+String(payload.id??"new"),data:{url},
  }));
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
