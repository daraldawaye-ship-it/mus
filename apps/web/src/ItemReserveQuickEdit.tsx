import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { normalizeDigits } from "../../../packages/contracts/src/index";
import { api } from "./api";
import { errorMessage } from "./phase2";

export function ItemReserveQuickEdit({
  companyId, itemId, revision, reserveQuantity, canEdit,
}: {
  companyId: number; itemId: number; revision: number;
  reserveQuantity: string; canEdit: boolean;
}) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(reserveQuantity);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const changing = useRef(false);
  const busy = useRef(false);
  useEffect(() => {
    if (changing.current || busy.current) return;
    setValue(reserveQuantity);
    setError("");
  }, [reserveQuantity, revision, itemId]);

  async function save() {
    if (!canEdit || busy.current) return;
    changing.current = false;
    const normalized = normalizeDigits(value.trim());
    if (!/^\d{1,22}$/.test(normalized)) {
      setError("أدخل عددًا صحيحًا غير سالب حتى 22 رقمًا.");
      return;
    }
    const next = BigInt(normalized).toString();
    if (next === reserveQuantity) {
      setValue(next);
      setError("");
      return;
    }
    busy.current = true;
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const response = await api<{ result: { reserveQuantity: string; revision: number } }>(
        `/companies/${companyId}/items/${itemId}/reserve-quantity`,
        { method: "PATCH", body: { revision, reserveQuantity: next } },
      );
      setValue(response.result.reserveQuantity);
      setSaved(true);
      void queryClient.invalidateQueries({ queryKey: ["item-options-list"] });
      void queryClient.invalidateQueries({ queryKey: ["items"] });
    } catch (reason) {
      setError(errorMessage(reason));
      if (reason instanceof Error && reason.message.includes("عُدّل"))
        void queryClient.invalidateQueries({ queryKey: ["item-options-list"] });
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }
  return <div className="item-reserve-quick-edit">
    <div className="item-reserve-input-wrap">
      <input type="text" inputMode="numeric" dir="ltr"
        aria-label="كمية احتياط بأصغر وحدة للصنف"
        title="كمية احتياط بأصغر وحدة مفعّلة — حفظ عند مغادرة الحقل أو الضغط Enter"
        value={value}
        disabled={!canEdit || saving}
        onFocus={() => { changing.current = true; setSaved(false); }}
        onChange={event => {
          changing.current = true;
          setValue(event.target.value);
          setError("");
        }}
        onBlur={() => { void save(); }}
        onKeyDown={event => {
          if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
          if (event.key === "Escape") {
            changing.current = false;
            setValue(reserveQuantity);
            setError("");
            event.currentTarget.blur();
          }
        }}
      />
      {saving && <span className="muted" role="status">حفظ…</span>}
      {!saving && saved && !error && <span className="text-success" title="حُفظ الاحتياط">✓</span>}
    </div>
    {error && <small className="text-error" role="alert">{error}</small>}
  </div>;
}
