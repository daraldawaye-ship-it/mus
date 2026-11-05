import { useState, type FormEvent } from "react";
import {
  accountChoiceLabels,
  invoiceQuickAccountChoices,
  invoiceQuickAccountSchema,
  type Account,
  type InvoiceKind,
} from "../../../packages/contracts/src/index.ts";
import { api } from "./api";
import { errorMessage } from "./phase2";
import { Button, Dialog, Field, Notice, Select } from "./ui";

/**
 * Invoice-only account quick add: exactly two editable inputs.
 * Code, parent group and accounting metadata are server-assigned.
 */
export function InvoiceQuickAccountDialog({
  companyId,kind,onClose,onCreated,
}:{
  companyId:number;
  kind:InvoiceKind;
  onClose:()=>void;
  onCreated:(account:Account)=>void;
}) {
  const [name,setName]=useState("");
  const [accountChoice,setAccountChoice]=useState<(typeof invoiceQuickAccountChoices)[number]>("customer");
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState("");
  async function save(event:FormEvent) {
    event.preventDefault();
    if(saving)return;
    const parsed=invoiceQuickAccountSchema.safeParse({
      name,accountChoice,kind,
    });
    if(!parsed.success){
      setError(parsed.error.issues[0]?.message??"راجع بيانات الحساب.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const result=await api<{account:Account}>(
        `/companies/${companyId}/invoices/quick-account`,{
          method:"POST",body:parsed.data,
        });
      onCreated(result.account);
    }catch(cause){
      setError(errorMessage(cause));
    }finally{
      setSaving(false);
    }
  }
  return <Dialog open title="إضافة حساب" onClose={()=>{if(!saving)onClose();}}>
    <form className="form-stack" onSubmit={event=>void save(event)}>
      <Field label="اسم الحساب" required autoFocus maxLength={500}
        value={name} disabled={saving}
        onChange={event=>setName(event.target.value)} />
      <Select label="خيار الحساب" required value={accountChoice} disabled={saving}
        onChange={event=>setAccountChoice(event.target.value as typeof accountChoice)}>
        {invoiceQuickAccountChoices.map(choice=>
          <option value={choice} key={choice}>{accountChoiceLabels[choice]}</option>)}
      </Select>
      {error&&<Notice tone="error">{error}</Notice>}
      <div className="form-actions">
        <Button type="submit" disabled={saving || !name.trim()}>
          {saving?"جارٍ إضافة الحساب…":"حفظ الحساب"}
        </Button>
        <Button type="button" variant="secondary" disabled={saving}
          onClick={onClose}>إلغاء</Button>
      </div>
    </form>
  </Dialog>;
}
