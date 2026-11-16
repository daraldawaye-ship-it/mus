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
    <label className="check-label">
      <input type="checkbox" checked={reviewed} disabled={!canEdit || saving}
        onChange={event => void save(event.target.checked)} />
      مراجع
      {saving && <small role="status">حفظ…</small>}
    </label>
    {error && <small className="text-error" role="alert">{error}</small>}
  </div>;
}
