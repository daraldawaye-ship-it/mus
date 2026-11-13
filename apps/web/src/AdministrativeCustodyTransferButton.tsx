import { useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { normalizeDigits, type Doctor, type Page } from "../../../packages/contracts/src/index";
import { api, ApiFailure, sessionRequiresLogin, useSession } from "./api";
import { isOfflineNow } from "./connection-mode";
import { errorMessage } from "./phase2";
import { Button, Dialog, Field, Notice } from "./ui";

type CustodyDraft = {
  amount: string;
  notes: string;
  idempotencyKey: string;
  expenseKind: "medical" | "slips" | "other";
  doctor: Doctor | null;
  doctorQuery: string;
  slipCount: string;
};

export function AdministrativeCustodyTransferButton({
  companyId, disabled,
}: {
  companyId: number;
  disabled: boolean;
}) {
  const client = useQueryClient();
  const { user } = useSession();
  const [choosing, setChoosing] = useState(false);
  const [draft, setDraft] = useState<CustodyDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const doctors = useQuery({
    queryKey: ["custody-beneficiaries", user?.id, companyId, draft?.expenseKind, draft?.doctorQuery],
    queryFn: ({ signal }) => api<Page<Doctor>>(`/companies/${companyId}/doctors?active=true&medicalKind=${draft?.expenseKind === "slips" ? "nurse" : "medical"}&q=${encodeURIComponent(draft?.doctorQuery ?? "")}&page=1&pageSize=20&sort=name:asc`, { signal }),
    enabled: !!draft && draft.expenseKind !== "other" && !draft.doctor && !unknown,
  });

  function open() {
    setChoosing(true);
    setError("");
    setNotice("");
  }

  function choose(expenseKind: CustodyDraft["expenseKind"]) {
    setChoosing(false);
    setError("");
    setNotice("");
    setUnknown(false);
    setDraft({ amount: "", notes: "", idempotencyKey: crypto.randomUUID(),
      expenseKind, doctor: null, doctorQuery: "", slipCount: "" });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    // Prevent the invoice editor's parent form from submitting as well.
    event.stopPropagation();
    if (!draft || busy || (disabled && !unknown)) return;
    if (isOfflineNow() || sessionRequiresLogin()) {
      setError("ترحيل العهدة يتطلب اتصالًا مباشرًا بالنظام؛ لا يُحفظ محليًا.");
      return;
    }
    const amount = normalizeDigits(draft.amount.trim());
    if (!/^-?(?:0|[1-9][0-9]{0,19})(?:\.[0-9]{1,2})?$/.test(amount) ||
        /^-?0(?:\.0{1,2})?$/.test(amount)) {
      setError("أدخل مبلغًا موجبًا أو سالبًا غير صفري، بحد أقصى منزلتين عشريتين.");
      return;
    }
    const isMedical = draft.expenseKind !== "other";
    if (isMedical && (!draft.doctor || amount.startsWith("-"))) {
      setError("اختر المستفيد وأدخل مبلغ صرف موجبًا."); return;
    }
    const slipCount = normalizeDigits(draft.slipCount.trim());
    if (draft.expenseKind === "slips" && (!/^[1-9][0-9]*$/.test(slipCount) || Number(slipCount) > 2147483647)) {
      setError("أدخل عدد قصاصات موجبًا صحيحًا."); return;
    }
    if (!window.confirm(draft.expenseKind === "medical"
      ? `تأكيد صرف المبلغ إلى ${draft.doctor!.name} وتأشير جميع مبيعاته السابقة «محاسب حتى هنا»؟`
      : draft.expenseKind === "slips"
      ? `تأكيد صرف القصاصات للممرض ${draft.doctor!.name}، العدد ${slipCount}، دون تأشير المبيعات كمحاسبة؟`
      : amount.startsWith("-")
      ? "هل تريد إعادة المبلغ من حافظة العهدة الإدارية إلى حساب العهدة؟"
      : "هل تريد ترحيل المبلغ من العهدة الإدارية إلى حافظتها؟")) return;

    setBusy(true);
    setError("");
    try {
      const posted = await api<{ operationId: number; documentId: number }>(
        "/companies/" + companyId + "/sales/administrative-custody-transfers",
        { method: "POST", body: { amount, notes: draft.notes, idempotencyKey: draft.idempotencyKey,
          expenseKind: draft.expenseKind,
          ...(isMedical ? { doctorId: draft.doctor!.id } : {}),
          ...(draft.expenseKind === "slips" ? { slipCount: Number(slipCount) } : {}),
        } },
      );
      setDraft(null);
      setUnknown(false);
      setNotice("تم تسجيل ترحيل العهدة بالقيد #" + posted.documentId);
      await client.invalidateQueries({ predicate: query =>
        query.queryKey.includes(companyId) &&
        ["finance", "account-ledger", "account-balances", "financial-documents", "doctor-sales-movements"].includes(
          String(query.queryKey[0]),
        ),
      });
    } catch (cause) {
      // For an uncertain network result keep the same UUID and lock the amount
      // so retry can only confirm/replay the same journal, never duplicate it.
      const uncertain = !(cause instanceof ApiFailure) || cause.status >= 500;
      setUnknown(uncertain);
      setError((uncertain
        ? "نتيجة الاتصال غير مؤكدة. أعد تأكيد الطلب نفسه؛ لن ينشئ النظام قيدًا مكررًا. "
        : "") + errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="secondary" size="compact" disabled={disabled || busy || unknown} onClick={open}>
        العهدة
      </Button>
      {notice && <small role="status" className="muted">{notice}</small>}
      {choosing && createPortal(<Dialog open={true} title="الصرف من العهدة الإدارية"
        onClose={() => setChoosing(false)}>
        <div className="form-stack">
          <Button onClick={() => choose("medical")}>صرف لطبيب أو ممرض</Button>
          <Button onClick={() => choose("slips")}>صرف للقصاصة</Button>
          <Button variant="secondary" onClick={() => choose("other")}>نثريات أخرى</Button>
        </div>
      </Dialog>, document.body)}
      {draft && createPortal(<Dialog open={true} title={draft.expenseKind === "medical"
        ? "صرف لطبيب أو ممرض" : draft.expenseKind === "slips" ? "صرف للقصاصة" : "ترحيل العهدة الإدارية"}
        onClose={() => { if (!busy && !unknown) setDraft(null); }}>
        {draft && (
          <form className="form-stack" onSubmit={event => void submit(event)}>
            {draft.expenseKind === "other" && <p>الترحيل بين حساب العهدة الإدارية وحافظتها المستقلة، دون المساس بصندوق الموظف أو حوافظه أو المحفظة الإلكترونية.</p>}
            {draft.expenseKind !== "other" && <>
              <Field label={draft.expenseKind === "slips" ? "البحث عن ممرض" : "البحث عن طبيب أو ممرض"}
                type="search" autoFocus required value={draft.doctorQuery} disabled={busy || unknown}
                onChange={event => setDraft(previous => previous ? { ...previous, doctorQuery: event.target.value, doctor: null } : previous)} />
              {!draft.doctor && <div className="form-stack" style={{ maxHeight: 180, overflowY: "auto" }}>
                {doctors.isPending && <small role="status">جارٍ البحث…</small>}
                {doctors.isError && <Notice tone="error">تعذر البحث عن المستفيد. <Button variant="secondary" size="compact" onClick={() => void doctors.refetch()}>إعادة المحاولة</Button></Notice>}
                {doctors.data?.items.map(doctor => <Button key={doctor.id} variant="secondary" size="compact"
                  disabled={busy || unknown} onClick={() => setDraft(previous => previous
                    ? { ...previous, doctor, doctorQuery: doctor.name } : previous)}>
                  {doctor.name}{doctor.sharedName && doctor.sharedName !== doctor.name ? ` — ${doctor.sharedName}` : ""}
                </Button>)}
                {doctors.data?.items.length === 0 && <small>لا توجد نتائج مطابقة.</small>}
              </div>}
              {draft.expenseKind === "slips" && <Field label="عدد القصاصات" required inputMode="numeric"
                pattern="[0-9]+" value={draft.slipCount} disabled={busy || unknown}
                onChange={event => setDraft(previous => previous ? { ...previous, slipCount: normalizeDigits(event.target.value) } : previous)} />}
              <small className="muted">{draft.expenseKind === "medical"
                ? "بعد حفظ الصرف تُؤشّر جميع المبيعات السابقة للاسم الرئيسي وكروته الفرعية بأنها محاسب."
                : "يحفظ العدد للممرض دون تأشير مبيعاته كمحاسبة."}</small>
            </>}
            <Field label="المبلغ" money inputMode="decimal" autoFocus={draft.expenseKind === "other"} required
              value={draft.amount} disabled={busy || unknown}
              onChange={event => setDraft(previous => previous
                ? { ...previous, amount: normalizeDigits(event.target.value) } : previous)} />
            <Field label="ملاحظات" maxLength={1000}
              value={draft.notes} disabled={busy || unknown}
              onChange={event => setDraft(previous => previous
                ? { ...previous, notes: event.target.value } : previous)} />
            {draft.expenseKind === "other" && <small className="muted">
              الموجب: من العهدة إلى حافظتها. السالب: من حافظة العهدة إليها.
              يسمح برصيد موجب أو سالب في الحسابين، ولا يُشترط توفر رصيد.
            </small>}
            {error && <Notice tone="error">{error}</Notice>}
            <div className="form-actions">
              <Button type="submit" disabled={busy}>
                {busy ? "جارٍ الترحيل…" : unknown ? "إعادة تأكيد الطلب نفسه" : "حفظ وترحيل"}
              </Button>
              <Button variant="secondary" type="button" disabled={busy || unknown}
                onClick={() => setDraft(null)}>إلغاء</Button>
            </div>
          </form>
        )}
      </Dialog>, document.body)}
    </>
  );
}
