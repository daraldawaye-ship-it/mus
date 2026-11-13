import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { normalizeDigits } from "../../../packages/contracts/src/index";
import type { SlipReceiptResult } from "../../../packages/contracts/src/slip-receipts";
import { api, ApiFailure } from "./api";
import { errorMessage } from "./phase2";
import { isOfflineNow } from "./connection-mode";
import { Button, Dialog, Field, Notice } from "./ui";

export function SlipReceiptDialog({companyId,onClose}:{companyId:number;onClose:()=>void}) {
  const client=useQueryClient();
  const [count,setCount]=useState("");
  const [key]=useState(()=>crypto.randomUUID());
  const [busy,setBusy]=useState(false),[unknown,setUnknown]=useState(false);
  const [error,setError]=useState("");
  const [saved,setSaved]=useState<SlipReceiptResult|null>(null);
  async function submit(event:FormEvent) {
    event.preventDefault();
    if(busy)return;
    if(isOfflineNow()){setError("استلام القصاصات يتطلب اتصالًا مباشرًا.");return;}
    const value=normalizeDigits(count.trim());
    if(!/^(0|[1-9][0-9]*)$/.test(value)||Number(value)>2147483647){setError("أدخل عددًا صحيحًا صفرًا أو أكبر.");return;}
    setBusy(true);setError("");
    try {
      const result=await api<SlipReceiptResult>(`/companies/${companyId}/slip-movements`,{
        method:"POST",body:{count:Number(value),idempotencyKey:key},
      });
      setSaved(result);setUnknown(false);
      void client.invalidateQueries({queryKey:["slip-movements",companyId]});
    } catch(cause) {
      const uncertain=!(cause instanceof ApiFailure)||cause.status>=500;
      setUnknown(uncertain);
      setError((uncertain?"النتيجة غير مؤكدة؛ أعد المحاولة بالعدد نفسه. ":"")+errorMessage(cause));
    } finally {setBusy(false);}
  }
  const difference=saved?BigInt(saved.difference):0n;
  return <Dialog open title="استلام القصاصات" onClose={()=>{if(!busy&&!unknown)onClose();}}>
    {saved?<>
      <Notice tone="success">تم حفظ استلام {saved.received} قصاصة.</Notice>
      <p>المرحّل: {saved.expected} — {difference<0n?`نقص ${-difference}`:difference>0n?`زيادة ${difference}`:"مطابق دون فارق"}</p>
      <Button onClick={onClose}>إغلاق</Button>
    </>:<form className="form-stack" onSubmit={event=>void submit(event)}>
      <Field label="عدد القصاصات المستلمة" inputMode="numeric" autoFocus required
        value={count} disabled={busy||unknown} onChange={event=>setCount(normalizeDigits(event.target.value))}/>
      {error&&<Notice tone="error">{error}</Notice>}
      <Button type="submit" disabled={busy}>{busy?"جارٍ الحفظ…":unknown?"إعادة المحاولة":"حفظ"}</Button>
    </form>}
  </Dialog>;
}
