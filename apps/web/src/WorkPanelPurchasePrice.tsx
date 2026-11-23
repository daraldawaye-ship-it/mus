import { useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { amountSchema, itemFieldPatchSchema, type Item } from "../../../packages/contracts/src/index";
import { api, ApiFailure, sessionRequiresLogin, useScopeGuard } from "./api";
import { isOfflineNow } from "./connection-mode";
import { MobileNumericPadInput, useMobileQuantityPad } from "./NumericPadField";
import { errorMessage } from "./phase2";

const priceLabel = "سعر الشراء الافتراضي";
type Edit = { value: string; expected: string };

export type WorkPanelPurchasePriceAccess = {
  canEdit:boolean;
  online:boolean;
  saveScope:ReturnType<typeof useScopeGuard>;
  onDetachedSaveError:(message:string)=>void;
};

export function WorkPanelPurchasePrice({userId,companyId,itemId,canEdit,online,saveScope,onDetachedSaveError}:
  {userId:number;companyId:number;itemId:number} & WorkPanelPurchasePriceAccess
) {
  const id=useId();
  const mobile=useMobileQuantityPad();
  const client=useQueryClient();
  const guard=useScopeGuard(`work-panel-purchase-price:${userId}:${companyId}:${itemId}`);
  const [edit,setEdit]=useState<Edit|null>(null);
  const [pending,setPending]=useState(false);
  const [issue,setIssue]=useState<{text:string;conflict?:boolean}|null>(null);
  const busy=useRef(false);
  const focusBaseline=useRef<string|null>(null);
  const queryKey=["work-panel-purchase-price",userId,companyId,itemId] as const;
  const path=`/companies/${companyId}/items/${itemId}`;
  const query=useQuery({queryKey, queryFn:({signal})=>api<{item:Item}>(path,{signal}),staleTime:0});
  const item=query.data?.item;
  const valid=!!item&&item.id===itemId&&item.companyId===companyId;
  const disabled=!valid||!canEdit||!online||pending||!!issue?.conflict;
  const maxDecimals=Math.min(6,Math.max(4,item?.currencyDecimalPlaces??4));

  async function commit(change:Edit|null) {
    if(!change||disabled||busy.current||!guard.isCurrent()||!saveScope.isCurrent()||isOfflineNow()||sessionRequiresLogin())return;
    const parsed=amountSchema.safeParse(change.value);
    if(!parsed.success){setIssue({text:"أدخل سعرًا صالحًا؛ الفراغ لا يعني صفرًا."});return;}
    const fraction=parsed.data.split(".")[1]??"";
    if(fraction.length>maxDecimals){setIssue({text:`عدد الكسور المسموح: ${maxDecimals}.`});return;}
    const expected=amountSchema.safeParse(change.expected);
    if(expected.success&&parsed.data===expected.data){setEdit(null);setIssue(null);return;}
    const payload=itemFieldPatchSchema.safeParse({changes:{purchasePrice:parsed.data},expected:{purchasePrice:change.expected}});
    if(!payload.success){setIssue({text:payload.error.issues[0]?.message??"تعذر التحقق من السعر."});return;}
    busy.current=true;
    setPending(true);
    setIssue(null);
    try {
      // Keep a committed edit tied to the dock's user/company, not to which
      // item's purchase history is currently visible.
      const response=await api<{item:Item}>(path,{method:"PATCH",body:payload.data,signal:saveScope.signal});
      if(!saveScope.isCurrent())return;
      const saved=amountSchema.safeParse(response.item.purchasePrice);
      if(response.item.id!==itemId||response.item.companyId!==companyId||!saved.success||saved.data!==parsed.data)
        throw new Error("تعذر تأكيد السعر المحفوظ لهذا الصنف.");
      await client.cancelQueries({queryKey,exact:true});
      if(!saveScope.isCurrent())return;
      client.setQueryData<{item:Item}>(queryKey,old=>old&&old.item.revision>response.item.revision?old:response);
      if(guard.isCurrent()){
        focusBaseline.current=null;
        setEdit(null);
      }
      for(const key of [
        ["items",userId,companyId],["work-panel-compact-card",userId,companyId,itemId],
        ["item-options-list",userId,companyId],
      ]) void client.invalidateQueries({queryKey:key});
    } catch(reason) {
      if(!saveScope.isCurrent())return;
      const conflict=reason instanceof ApiFailure&&reason.status===409;
      const message=conflict?"غيّر مستخدم آخر السعر. حمّل القيمة المحفوظة قبل تعديلها.":errorMessage(reason);
      if(guard.isCurrent())setIssue({text:message,conflict});
      else onDetachedSaveError(`لم يتأكد حفظ سعر الشراء للصنف ${item?.name??itemId}: ${message}`);
    } finally {
      busy.current=false;
      if(guard.isCurrent())setPending(false);
    }
  }

  async function loadSaved() {
    if(busy.current||!guard.isCurrent()||!online)return;
    busy.current=true;
    setPending(true);
    try {
      const result=await query.refetch({throwOnError:true});
      if(!guard.isCurrent())return;
      if(result.data?.item.id!==itemId||result.data.item.companyId!==companyId)
        throw new Error("تعذر تأكيد الصنف.");
      focusBaseline.current=null;
      setEdit(null);
      setIssue(null);
    } catch(reason) {
      if(guard.isCurrent())setIssue({text:errorMessage(reason),conflict:true});
    } finally {
      busy.current=false;
      if(guard.isCurrent())setPending(false);
    }
  }

  return <div className="work-panel-purchase-price">
    <label htmlFor={id}>{priceLabel}</label>
    <MobileNumericPadInput id={id} label={priceLabel} mobile={mobile} value={edit?.value??(valid?item.purchasePrice:"")}
      dir="ltr" inputMode="decimal" autoComplete="off" maxLength={29} maxIntegerDigits={22}
      allowDecimal maxDecimals={maxDecimals} allowEmpty disabled={disabled}
      onFocus={()=>{if(valid)focusBaseline.current=item.purchasePrice;}}
      onChange={event=>{
        if(!valid)return;
        const value=event.target.value;
        setEdit(old=>({value,expected:old?.expected??focusBaseline.current??item.purchasePrice}));
        setIssue(null);
      }}
      onBlur={()=>{focusBaseline.current=null;void commit(edit);}}
      onKeyDown={event=>{
        if(event.key==="Enter"&&!event.nativeEvent.isComposing){event.preventDefault();event.stopPropagation();void commit(edit);}
        if(event.key==="Escape"){event.stopPropagation();setEdit(null);setIssue(null);if(valid)focusBaseline.current=item.purchasePrice;}
      }}
      onConfirm={value=>{
        if(!valid||disabled)return;
        const change={value,expected:edit?.expected??focusBaseline.current??item.purchasePrice};
        setEdit(change);
        void commit(change);
      }}/>
    {pending&&<small role="status">جارٍ الحفظ…</small>}
    {query.isPending&&<small role="status">جارٍ تحميل السعر…</small>}
    {!query.isPending&&!valid&&<small role="alert">تعذر تحميل سعر هذا الصنف.</small>}
    {issue&&<small role="alert">{issue.text}</small>}
    {issue?.conflict&&<button type="button" className="button button-secondary button-compact"
      disabled={pending||!online} onClick={()=>void loadSaved()}>تحميل القيمة المحفوظة</button>}
  </div>;
}
