import { useEffect, useId, useState } from "react";
import { api, useSession } from "./api";
import { errorMessage } from "./phase2";

// Private owner-only field: never load through normal card/list endpoints.
export function OwnerAdministrativeNotes({
  companyId, kind, recordId,
}: {
  companyId: number;
  kind: "items" | "accounts";
  recordId: number;
}) {
  const { user } = useSession();
  const inputId = useId();
  const [notes, setNotes] = useState("");
  const [expected, setExpected] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const url = `/companies/${companyId}/${kind}/${recordId}/administrative-notes`;

  useEffect(() => {
    if (!user?.owner) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setMessage("");
    void api<{notes: string}>(url, { signal: controller.signal })
      .then(result => {
        if (controller.signal.aborted) return;
        setNotes(result.notes);
        setExpected(result.notes);
      })
      .catch(reason => {
        if (!controller.signal.aborted) setError(errorMessage(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [url, user?.id, user?.owner]);

  if (!user?.owner) return null;

  async function save() {
    if (loading || saving || notes === expected) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const result = await api<{notes: string}>(url, {
        method: "PATCH", body: { notes, expected },
      });
      setNotes(result.notes);
      setExpected(result.notes);
      setMessage("تم حفظ الملاحظات الإدارية.");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="form-stack" style={{ marginBlock: "8px" }}>
      <label htmlFor={inputId}><strong>ملاحظات إدارية</strong> <small className="muted">— للمالك فقط</small></label>
      {loading ? <small className="muted">جارٍ تحميل الملاحظات…</small> : (
        <>
          <textarea
            id={inputId}
            value={notes}
            maxLength={5000}
            rows={3}
            dir="auto"
            style={{ width: "100%", boxSizing: "border-box", minHeight: 78 }}
            placeholder="مثل: تمت مراجعة الحساب أو متابعة الصنف…"
            disabled={saving}
            onChange={event => { setNotes(event.target.value); setMessage(""); }}
          />
          <div className="form-actions">
            <button type="button" disabled={saving || notes === expected}
              onClick={() => void save()}>
              {saving ? "جارٍ الحفظ…" : "حفظ الملاحظات"}
            </button>
            {message && <small role="status">{message}</small>}
          </div>
        </>
      )}
      {error && <small role="alert" style={{ color: "var(--danger, #b42318)" }}>{error}</small>}
    </section>
  );
}
