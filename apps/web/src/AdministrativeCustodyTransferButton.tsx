import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { normalizeDigits } from "../../../packages/contracts/src/index";
import { api, ApiFailure, sessionRequiresLogin } from "./api";
import { isOfflineNow } from "./connection-mode";
import { errorMessage } from "./phase2";
import { Button, Dialog, Field, Notice } from "./ui";

type CustodyDraft = {
  amount: string;
  notes: string;
  idempotencyKey: string;
};

export function AdministrativeCustodyTransferButton({
  companyId, disabled,
}: {
  companyId: number;
  disabled: boolean;
}) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<CustodyDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  function open() {
    setError("");
    setNotice("");
    setUnknown(false);
    setDraft({ amount: "", notes: "", idempotencyKey: crypto.randomUUID() });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
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
    if (!window.confirm(amount.startsWith("-")
      ? "هل تريد إعادة المبلغ من المحفظة الإلكترونية إلى العهدة الإدارية؟"
      : "هل تريد ترحيل المبلغ من العهدة الإدارية إلى المحفظة الإلكترونية؟")) return;

    setBusy(true);
    setError("");
    try {
      const posted = await api<{ operationId: number; documentId: number }>(
        "/companies/" + companyId + "/sales/administrative-custody-transfers",
        { method: "POST", body: { amount, notes: draft.notes, idempotencyKey: draft.idempotencyKey } },
      );
      setDraft(null);
      setUnknown(false);
      setNotice("تم تسجيل ترحيل العهدة بالقيد #" + posted.documentId);
      await client.invalidateQueries({ predicate: query =>
        query.queryKey.includes(companyId) &&
        ["finance", "account-ledger", "account-balances", "financial-documents"].includes(
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
      <Button variant="secondary" size="compact" disabled={disabled} onClick={open}>
        العهدة
      </Button>
      {notice && <small role="status" className="muted">{notice}</small>}
      <Dialog open={draft !== null} title="ترحيل العهدة الإدارية"
        onClose={() => { if (!busy && !unknown) setDraft(null); }}>
        {draft && (
          <form className="form-stack" onSubmit={event => void submit(event)}>
            <p>الترحيل بين حساب العهدة الإدارية ومحفظة الشركة الإلكترونية، دون المساس بصندوق الموظف.</p>
            <Field label="المبلغ" money inputMode="decimal" autoFocus required
              value={draft.amount} disabled={busy || unknown}
              onChange={event => setDraft(previous => previous
                ? { ...previous, amount: normalizeDigits(event.target.value) } : previous)} />
            <Field label="ملاحظات" maxLength={1000}
              value={draft.notes} disabled={busy || unknown}
              onChange={event => setDraft(previous => previous
                ? { ...previous, notes: event.target.value } : previous)} />
            <small className="muted">
              الموجب: من العهدة إلى المحفظة. السالب: من المحفظة إلى العهدة.
              يسمح برصيد موجب أو سالب في الحسابين، ولا يُشترط توفر رصيد.
            </small>
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
      </Dialog>
    </>
  );
}
