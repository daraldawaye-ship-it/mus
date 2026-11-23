import { lazy,Suspense,useState,useSyncExternalStore,type ComponentProps } from "react";
import { useQuery,useQueryClient } from "@tanstack/react-query";
import type { CompanyContext,Item } from "../../../packages/contracts/src/index";
import { api,sessionRequiresLogin } from "./api";
import { connectionSnapshot,isOfflineNow,subscribeConnection } from "./connection-mode";
import { InvoiceItemActionsDropdown } from "./InvoiceItemActionsDropdown";
import { exactInvoiceItemCompositionId } from "./invoice-item-composition-access";
import { Dialog,Notice } from "./ui";

const CompositionEditorSheet=lazy(()=>import("./pages/ItemCompositionsPage").then(module=>({default:module.CompositionEditorSheet})));
type DropdownProps=Omit<ComponentProps<typeof InvoiceItemActionsDropdown>,"onEditComposition"|"onOpenChange"|"unavailableCompositionReason">;
type Props=DropdownProps&{
  userId:number|null;companyId:number|undefined;itemId:number;allowCompositionEdit:boolean;
  showUnavailableComposition?:boolean;
  openComposition:(id:number)=>void;
};

/** Re-read just the line whose dropdown is open, not each invoice row. */
export function InvoiceItemCompositionActions(props:Props) {
  return <ScopedActions key={`${props.userId??0}:${props.companyId??0}:${props.itemId}`} {...props}/>;
}
function ScopedActions({userId,companyId,itemId,allowCompositionEdit,openComposition,
  showUnavailableComposition,...dropdown}:Props) {
  const [open,setOpen]=useState(false);
  const online=useSyncExternalStore(subscribeConnection,connectionSnapshot)==="online"&&!sessionRequiresLogin();
  const eligible=open&&!!userId&&!!companyId&&itemId>0&&!dropdown.disabled&&allowCompositionEdit&&online;
  const itemQuery=useQuery({
    queryKey:["invoice-item-composition-link",userId,companyId,itemId],
    queryFn:({signal})=>api<{item:Item}>(`/companies/${companyId}/items/${itemId}`,{signal}),
    enabled:eligible,
    staleTime:0,
    retry:false,
  });
  const compositionId=eligible&&!itemQuery.isFetching&&!itemQuery.isError
    ?exactInvoiceItemCompositionId(itemQuery.data?.item,companyId,itemId):null;
  const unavailableCompositionReason=showUnavailableComposition&&compositionId===null
    ? !allowCompositionEdit ? "لا يتوفر إذن التعديل"
      : itemQuery.isFetching ? "جارٍ التحقق"
      : itemQuery.isError ? "تعذر التحقق من التركيب"
      : "لا يوجد تركيب مرتبط" : undefined;
  return <InvoiceItemActionsDropdown {...dropdown} onOpenChange={setOpen}
    unavailableCompositionReason={unavailableCompositionReason}
    onEditComposition={compositionId===null?undefined:()=>{
      if(!isOfflineNow()&&!sessionRequiresLogin())openComposition(compositionId);
    }}/>;
}

/** Render as a sibling of the invoice form so composition inputs and
 * submission never reach the invoice keyboard handlers or save action. */
export function InvoiceItemCompositionEditor({context,compositionId,userId,onClose}:{
  context:CompanyContext;compositionId:number;userId:number|null;onClose:()=>void;
}) {
  const client=useQueryClient();
  const companyId=context.company.id;
  return <Suspense fallback={<Dialog open title="كرت التركيب" onClose={onClose}>
    <Notice>جارٍ فتح كرت التركيب…</Notice></Dialog>}>
    <CompositionEditorSheet key={`${companyId}:${compositionId}`} context={context}
      compositionId={compositionId} onClose={onClose} onSaved={saved=>{
        if(saved.companyId!==companyId||saved.id!==compositionId)return;
        for (const key of [
          ["composition-sheet",userId,companyId,compositionId],
          ["list",userId,`company:${companyId}:item-compositions`],
          ["invoice-composition-peers",userId,companyId],
          ["avatar-item-alternatives",userId,companyId],
        ]) void client.invalidateQueries({queryKey:key});
        onClose();
      }}/>
  </Suspense>;
}
