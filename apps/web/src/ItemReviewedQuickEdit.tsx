import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { errorMessage } from "./phase2";

export function ItemReviewedQuickEdit({ companyId, itemId, revision, reviewed, canEdit }: {
  companyId: number; itemId: number; revision: number; reviewed: boolean; canEdit: boolean;
}) {
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function save(value: boolean) {
    if (saving || !canEdit) return;
    setSaving(true);
    setError("");
    try {
      await api(`/companies/${companyId}/items/${itemId}/reviewed`, {
        method: "PATCH", body: { revision, reviewed: value },
      });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["item-order-draft-review"] }),
        queryClient.invalidateQueries({ queryKey: ["item-options-list"] }),
        queryClient.invalidateQueries({ queryKey: ["items"] }),
      ]);
      setSaving(false);
    }
  }
  return <div>
    <div className="item-reviewed-chips" role="group" aria-label="حالة المراجعة">
      {[{ value: false, label: "غير مراجع" }, { value: true, label: "مراجع" }].map(option =>
        <button key={String(option.value)} type="button"
          className={reviewed === option.value ? "is-selected" : ""}
          aria-pressed={reviewed === option.value} disabled={!canEdit || saving}
          onClick={() => { if (reviewed !== option.value) void save(option.value); }}>
          {option.label}
        </button>)}
    </div>
    {saving && <small role="status">حفظ…</small>}
    {error && <small className="text-error" role="alert">{error}</small>}
  </div>;
}
