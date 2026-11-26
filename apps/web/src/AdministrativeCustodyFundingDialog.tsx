import { useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { normalizeDigits } from "../../../packages/contracts/src/index";
import { api, ApiFailure, sessionRequiresLogin } from "./api";
import { isOfflineNow } from "./connection-mode";
import { errorMessage } from "./phase2";
import { Button, Dialog, Field, Notice } from "./ui";

type Match = { varianceKind: "shortage" | "surplus" | null; varianceAmount: string };
type FundingResult = Match & {operationId: number; documentId: number; varianceDocumentId: number | null};
const cashPattern = /^(?:0|[1-9][0-9]{0,19})(?:\.[0-9]{1,2})?$/;

export function AdministrativeCustodyFundingDialog({
  companyId, onClose, onSaved,
}: { companyId: number; onClose: () => void; onSaved: (result: FundingResult) => void }) {
  const client = useQueryClient();
  const [amount, setAmount] = useState("");
  const [countedCash, setCountedCash] = useState("");
  const [expected, setExpected] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [key] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); event.stopPropagation();
    if (busy) return;
    if (isOfflineNow() || sessionRequiresLogin()) {
      setError("تغذية العهدة تتطلب اتصالًا مباشرًا؛ لا تُحفظ العملية محليًا."); return;
    }
    const value = normalizeDigits(amount.trim());
    if (!cashPattern.test(value) ||
        /^0(?:\.0{1,2})?$/.test(value)) {
      setError("أدخل مبلغًا موجبًا غير صفري، حتى منزلتين عشريتين."); return;
    }
    const count = normalizeDigits(countedCash.trim());
    if (!cashPattern.test(count)) {
      setError("أدخل المبلغ الموجود فعليًا قبل التغذية. اكتب صفرًا إذا كان الصندوق فارغًا."); return;
    }
    const endpoint = `/companies/${companyId}/sales/administrative-custody-funding`;
    const fields = { amount: value, countedCash: count, notes, idempotencyKey: key };
    setBusy(true); setError("");
    let posting = false;
    try {
      let book = expected;
      if (!unknown) {
        const preview = await api<Match & {bookBalance: string}>(endpoint, {
          method: "POST", body: {...fields, mode: "preview"},
        });
        const difference = preview.varianceKind === "shortage"
          ? `سيُرحّل قيد عجز بقيمة ${preview.varianceAmount} ريال.`
          : preview.varianceKind === "surplus"
            ? `سيُرحّل قيد زيادة بقيمة ${preview.varianceAmount} ريال.`
            : "الصندوق مطابق. لن يُنشأ قيد فرق.";
        if (!window.confirm(`المبلغ الفعلي قبل التغذية: ${count} ريال.\n${difference}\nتأكيد تحويل ${value} ريال من صندوق مبيعاتك إلى العهدة؟`)) return;
        book = preview.bookBalance;
        setExpected(book);
      }
      if (book === null) return;
      posting = true;
      const result = await api<FundingResult>(endpoint, {
        method: "POST", body: {...fields, mode: "post", expectedBookBalance: book},
      });
      await client.invalidateQueries({predicate: query => query.queryKey.includes(companyId) &&
        ["finance","account-ledger","account-balances","financial-documents","my-cashbox-ledger"]
          .includes(String(query.queryKey[0]))});
      onSaved(result);
    } catch (cause) {
      const uncertain = posting && (!(cause instanceof ApiFailure) || cause.status >= 500);
      setUnknown(uncertain);
      setError((uncertain ? "النتيجة غير مؤكدة؛ أعد تأكيد الطلب نفسه لتجنب تكرار القيد. " : "") +
        errorMessage(cause));
    } finally { setBusy(false); }
  }
  return createPortal(<Dialog open={true} title="تغذية العهدة"
    onClose={() => { if (!busy && !unknown) onClose(); }}>
    <form className="form-stack" onSubmit={event => void submit(event)}>
      <p>يُرحّل المبلغ من صندوق مبيعاتك إلى العهدة الإدارية مباشرة، وليس إلى حافظتها.</p>
      <Field label="المبلغ المتواجد بصندوق العهدة قبل تغذية العهدة" money inputMode="decimal" autoFocus required
        value={countedCash} disabled={busy || unknown}
        onChange={event => setCountedCash(normalizeDigits(event.target.value))} />
      <Field label="مبلغ التغذية بالريال اليمني" money inputMode="decimal" required
        value={amount} disabled={busy || unknown}
        onChange={event => setAmount(normalizeDigits(event.target.value))} />
      <Field label="ملاحظات" maxLength={1000} value={notes} disabled={busy || unknown}
        onChange={event => setNotes(event.target.value)} />
      {error && <Notice tone="error">{error}</Notice>}
      <div className="form-actions">
        <Button type="submit" disabled={busy}>
          {busy ? "جارٍ التنفيذ…" : unknown ? "إعادة تأكيد الطلب نفسه" : "مطابقة وتأكيد التغذية"}
        </Button>
        <Button variant="secondary" type="button" disabled={busy || unknown}
          onClick={onClose}>إلغاء</Button>
      </div>
    </form>
  </Dialog>, document.body);
}
