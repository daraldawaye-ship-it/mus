import { useSyncExternalStore } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { api } from "./api";
import type { QuickMessageKind } from "./UserMenuQuickCompose";

export type QuickMessagePayload = {
  kind: QuickMessageKind;
  companyId?: number;
  title?: string;
  text: string;
  clientRequestId: string;
};
type DeliveryStatus = "sending" | "sent" | "failed";
type Delivery = {
  request: QuickMessagePayload;
  userId: number;
  queryClient: QueryClient;
  status: DeliveryStatus;
  error: string;
};
type DeliveryView = { id: string; userId: number; kind: QuickMessageKind; status: DeliveryStatus; error: string };

const deliveries = new Map<string, Delivery>();
const listeners = new Set<() => void>();
let snapshot: readonly DeliveryView[] = [];
function emit() {
  snapshot = [...deliveries.values()].map(item=>({
    id:item.request.clientRequestId,
    userId:item.userId,
    kind:item.request.kind,
    status:item.status,
    error:item.error,
  }));
  for(const subscriber of listeners) subscriber();
}
function subscribe(callback: () => void) {
  listeners.add(callback);
  return () => {listeners.delete(callback);};
}
function getSnapshot() {return snapshot;}
const names: Record<QuickMessageKind,string> = {
  system_change:"طلب تعديل النظام",
  present_employees:"رسالة للمحضّرين",
  all_employees:"رسالة للموظفين",
  app_manager:"رسالة إلى مسؤول التطبيق",
  private_note:"الملاحظة الخاصة",
};
async function deliver(item:Delivery) {
  if(item.status==="sending" && deliveries.get(item.request.clientRequestId)!==item) return;
  item.status="sending";item.error="";emit();
  try {
    await api("/quick-messages",{method:"POST",body:item.request});
    item.status="sent";emit();
    if(item.request.kind==="private_note")
      void item.queryClient.invalidateQueries({queryKey:["private-notes"]});
    // Non-modal confirmation disappears without another click.
    window.setTimeout(()=>{
      if(deliveries.get(item.request.clientRequestId)===item && item.status==="sent") {
        deliveries.delete(item.request.clientRequestId);emit();
      }
    },3000);
  }catch(cause){
    item.status="failed";
    item.error=cause instanceof Error ? cause.message : "تعذر إرسال الطلب";
    emit();
  }
}
/** Starts the request before the compose dialog unmounts. Failed requests stay
 * in memory with their UUID so a retry cannot duplicate the original. */
export function queueQuickMessageDelivery(request:QuickMessagePayload,userId:number,queryClient:QueryClient) {
  if(deliveries.has(request.clientRequestId)) return;
  const item:Delivery={request,userId,queryClient,status:"sending",error:""};
  deliveries.set(request.clientRequestId,item);
  void deliver(item);
}
export function retryQuickMessageDelivery(id:string,userId:number) {
  const item=deliveries.get(id);
  if(!item||item.userId!==userId||item.status!=="failed")return;
  void deliver(item);
}
export function dismissQuickMessageDelivery(id:string,userId:number) {
  const item=deliveries.get(id);
  // Never dismiss in-flight requests, whose outcome is not yet known.
  if(!item||item.userId!==userId||item.status==="sending")return;
  deliveries.delete(id);emit();
}
export function QuickMessageDeliveryStatus({userId}:{userId:number|null}) {
  const updates=useSyncExternalStore(subscribe,getSnapshot,getSnapshot);
  const own=updates.filter(job=>job.userId===userId);
  if(!own.length)return null;
  return <section className="quick-message-delivery-status" aria-label="حالة إرسال الرسائل">
    {own.map(job=><div key={job.id} className={"quick-message-delivery-card "+job.status}
      role={job.status==="failed"?"alert":"status"}>
      <span>{job.status==="sending"?"جارٍ إرسال ":job.status==="sent"?"تم إرسال ":"فشل إرسال "}
        {names[job.kind]}{job.status==="failed"&&job.error?" — "+job.error:""}
      </span>
      {job.status==="failed"&&userId!==null&&<>
        <button type="button" onClick={()=>retryQuickMessageDelivery(job.id,userId)}>إعادة المحاولة</button>
        <button type="button" onClick={()=>dismissQuickMessageDelivery(job.id,userId)}>إغلاق</button>
      </>}
    </div>)}
  </section>;
}
