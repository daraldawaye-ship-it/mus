import { useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { normalizeDigits } from "../../../packages/contracts/src/index";
import { api, ApiFailure, sessionRequiresLogin } from "./api";
import { isOfflineNow } from "./connection-mode";
import { errorMessage } from "./phase2";
import { Button, Dialog, Field, Notice } from "./ui";

export function AdministrativeCustodyFundingDialog({
  companyId, onClose, onSaved,
}: { companyId: number; onClose: () => void; onSaved: (documentId: number) => void }) {
  const client = useQueryClient();
  const [amount, setAmount] = useState("");
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
    if (!/^(?:0|[1-9][0-9]{0,19})(?:\.[0-9]{1,2})?$/.test(value) ||
        /^0(?:\.0{1,2})?$/.test(value)) {
      setError("أدخل مبلغًا موجبًا غير صفري، حتى منزلتين عشريتين."); return;
    }
    if (!window.confirm("تأكيد تحويل " + value + " ريال من صندوق مبيعاتك إلى العهدة الإدارية؟")) return;
    setBusy(true); setError("");
    try {
      const result = await api<{operationId: number; documentId: number}>(
        `/companies/${companyId}/sales/administrative-custody-funding`, {
          method: "POST", body: { amount: value, notes, idempotencyKey: key },
        },
      );
      await client.invalidateQueries({predicate: query => query.queryKey.includes(companyId) &&
        ["finance","account-ledger","account-balances","financial-documents","my-cashbox-ledger"]
          .includes(String(query.queryKey[0]))});
      onSaved(result.documentId);
    } catch (cause) {
      const uncertain = !(cause instanceof ApiFailure) || cause.status >= 500;
      setUnknown(uncertain);
      setError((uncertain ? "النتيجة غير مؤكدة؛ أعد تأكيد الطلب نفسه لتجنب تكرار القيد. " : "") +
        errorMessage(cause));
    } finally { setBusy(false); }
  }
  return createPortal(<Dialog open={true} title="تغذية العهدة"
    onClose={() => { if (!busy && !unknown) onClose(); }}>
    <form className="form-stack" onSubmit={event => void submit(event)}>
      <p>يُرحّل المبلغ من صندوق مبيعاتك إلى العهدة الإدارية مباشرة، وليس إلى حافظتها.</p>
      <Field label="المبلغ بالريال اليمني" money inputMode="decimal" autoFocus required
        value={amount} disabled={busy || unknown}
        onChange={event => setAmount(normalizeDigits(event.target.value))} />
      <Field label="ملاحظات" maxLength={1000} value={notes} disabled={busy || unknown}
        onChange={event => setNotes(event.target.value)} />
      {error && <Notice tone="error">{error}</Notice>}
      <div className="form-actions">
        <Button type="submit" disabled={busy}>
          {busy ? "جارٍ الترحيل…" : unknown ? "إعادة تأكيد الطلب نفسه" : "تأكيد التغذية والترحيل"}
        </Button>
        <Button variant="secondary" type="button" disabled={busy || unknown}
          onClick={onClose}>إلغاء</Button>
      </div>
    </form>
  </Dialog>, document.body);
}
