import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { normalizeDigits, type Doctor, type FinancialDocument, type Page } from "../../../packages/contracts/src/index";
import { api, ApiFailure, sessionRequiresLogin, useSession } from "./api";
import { isOfflineNow } from "./connection-mode";
import { errorMessage } from "./phase2";
import { Button, Dialog, Field, Notice } from "./ui";

type ExpenseKind = "medical" | "slips";
type Draft = {
  expenseKind: ExpenseKind;
  doctor: Doctor | null;
  doctorQuery: string;
  amount: string;
  slipCount: string;
  notes: string;
  idempotencyKey: string;
};

/** Cashier posts a real expense/payment voucher, bypassing custody and pouches. */
export function DirectMedicalPaymentDialog({
  companyId, onClose, onSaved,
}: {
  companyId: number;
  onClose: () => void;
  onSaved: (document: FinancialDocument) => void;
}) {
  const { user } = useSession();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [error, setError] = useState("");
  const doctors = useQuery({
    queryKey: ["direct-payment-beneficiaries", user?.id, companyId, draft?.expenseKind, draft?.doctorQuery],
    queryFn: ({ signal }) => api<Page<Doctor>>(
      `/companies/${companyId}/doctors?active=true&medicalKind=${draft?.expenseKind === "slips" ? "nurse" : "medical"}&q=${encodeURIComponent(draft?.doctorQuery ?? "")}&page=1&pageSize=20&sort=name:asc`,
      { signal }),
    enabled: !!draft && !draft.doctor && !unknown,
  });
  const choose = (kind: ExpenseKind) => {
    setDraft({ expenseKind: kind, doctor: null, doctorQuery: "", amount: "",
      slipCount: "", notes: "", idempotencyKey: crypto.randomUUID() });
    setError("");
    setUnknown(false);
  };
  async function submit(event: FormEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (!draft || busy) return;
    if (isOfflineNow() || sessionRequiresLogin()) {
      setError("سند الصرف المباشر يحتاج اتصالًا بالخادم ولا يُحفظ محليًا."); return;
    }
    const amount = normalizeDigits(draft.amount.trim()).replace(/٫/g, ".");
    const slipCount = normalizeDigits(draft.slipCount.trim());
    if (!/^(?:0|[1-9][0-9]{0,19})(?:\.[0-9]{1,2})?$/.test(amount) ||
        !/[1-9]/.test(amount)) {
      setError("أدخل مبلغ صرف موجبًا بحد أقصى منزلتين عشريتين."); return;
    }
    if (!draft.doctor) {
      setError("حدد الطبيب أو الممرض المستفيد."); return;
    }
    if (draft.expenseKind === "slips" &&
        (!/^[1-9][0-9]*$/.test(slipCount) || Number(slipCount) > 2147483647)) {
      setError("أدخل عدد قصاصات موجبًا صحيحًا."); return;
    }
    if (!unknown && !window.confirm(draft.expenseKind === "medical"
      ? `تأكيد صرف عمولة ${draft.doctor.name} مباشرة من الصندوق وتأشير مبيعاته السابقة «محاسب حتى هنا»؟`
      : `تأكيد صرف ${amount} للقصاصات للممرض ${draft.doctor.name}، عدد ${slipCount}، دون تأشير المبيعات؟`)) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ operationId: number; documentId: number; document: FinancialDocument }>(
        `/companies/${companyId}/my-cashbox/direct-medical-payment`,
        { method: "POST", body: {
          amount, notes: draft.notes, expenseKind: draft.expenseKind,
          doctorId: draft.doctor.id,
          ...(draft.expenseKind === "slips" ? { slipCount: Number(slipCount) } : {}),
          idempotencyKey: draft.idempotencyKey,
        } },
      );
      onSaved(result.document);
    } catch (cause) {
      const uncertain = !(cause instanceof ApiFailure) || cause.status >= 500;
      setUnknown(uncertain);
      setError((uncertain
        ? "نتيجة الاتصال غير مؤكدة؛ أعد تأكيد الطلب نفسه بالمفتاح نفسه لمنع التكرار. "
        : "") + errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open title={draft
      ? (draft.expenseKind === "medical" ? "صرف عمولة مباشرة من الصندوق" : "صرف قصاصات مباشرة من الصندوق")
      : "إضافة عمولة أو قصاصة"} onClose={() => { if (!busy && !unknown) onClose(); }}>
      {!draft ? <div className="form-stack">
        <Button onClick={() => choose("slips")}>قصاصة</Button>
        <Button onClick={() => choose("medical")}>طبيب أو ممرض</Button>
        <Button variant="secondary" onClick={onClose}>إلغاء</Button>
      </div> : <form className="form-stack" onSubmit={event => void submit(event)}>
        <Field label={draft.expenseKind === "slips" ? "الممرض" : "الطبيب أو الممرض"}
          type="search" required autoFocus value={draft.doctorQuery} disabled={busy || unknown}
          onChange={event => setDraft(prev => prev
            ? {...prev, doctorQuery: event.target.value, doctor: null} : prev)} />
        {!draft.doctor && <div className="form-stack" style={{ maxHeight: 180, overflowY: "auto" }}>
          {doctors.isPending && <small>جارٍ البحث…</small>}
          {doctors.isError && <Notice tone="error">تعذر تحميل الأطباء والممرضين. <Button size="compact" variant="secondary" onClick={() => void doctors.refetch()}>إعادة</Button></Notice>}
          {doctors.data?.items.map(doctor => <Button key={doctor.id} size="compact" variant="secondary"
            disabled={busy || unknown} onClick={() => setDraft(prev => prev
              ? {...prev, doctor, doctorQuery: doctor.name} : prev)}>
            {doctor.name}{doctor.sharedName && doctor.sharedName !== doctor.name ? ` — ${doctor.sharedName}` : ""}
          </Button>)}
          {doctors.data?.items.length === 0 && <small>لا توجد أسماء مطابقة.</small>}
        </div>}
        {draft.expenseKind === "slips" && <Field label="عدد القصاصات" required inputMode="numeric"
          pattern="[0-9]+" value={draft.slipCount} disabled={busy || unknown}
          onChange={event => setDraft(prev => prev
            ? {...prev, slipCount: normalizeDigits(event.target.value)} : prev)} />}
        <Field label="المبلغ" money required inputMode="decimal" value={draft.amount}
          disabled={busy || unknown} onChange={event => setDraft(prev => prev
            ? {...prev, amount: normalizeDigits(event.target.value)} : prev)} />
        <Field label="ملاحظات" maxLength={1000} value={draft.notes}
          disabled={busy || unknown} onChange={event => setDraft(prev => prev
            ? {...prev, notes: event.target.value} : prev)} />
        <small className="muted">{draft.expenseKind === "medical"
          ? "يُصرف مباشرة من صندوقك إلى حساب العمولات وتؤشَّر المبيعات السابقة محاسب حتى هنا."
          : "يُصرف مباشرة من صندوقك إلى حساب القصاصات ويُسجَّل العدد للمطابقة، دون تأشير المبيعات."}</small>
        {error && <Notice tone="error">{error}</Notice>}
        <div className="form-actions">
          <Button type="submit" disabled={busy}>{busy
            ? "جارٍ الحفظ…" : unknown ? "إعادة تأكيد السند نفسه" : "حفظ وترحيل سند الصرف"}</Button>
          <Button variant="secondary" type="button" disabled={busy || unknown}
            onClick={() => setDraft(null)}>عودة</Button>
        </div>
      </form>}
    </Dialog>
  );
}
