import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { normalizeDigits } from "../../../packages/contracts/src/index";
import { api } from "./api";
import { errorMessage } from "./phase2";

const quantityPattern = /^\d{1,22}$/;

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
  // Each rapid + or − tap updates the displayed number immediately.
  // Writes are serialized and the next write uses the server's new revision.
  const latestValue = useRef(reserveQuantity);
  const persistedValue = useRef(reserveQuantity);
  const persistedRevision = useRef(revision);
  const busy = useRef(false);
  const editFocused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Never replace a newer locally committed revision with a stale list poll.
    if (revision < persistedRevision.current) return;
    if (revision === persistedRevision.current &&
        reserveQuantity === persistedValue.current) return;
    if (busy.current) return;
    persistedRevision.current = revision;
    persistedValue.current = reserveQuantity;
    if (!editFocused.current && timer.current === null) {
      latestValue.current = reserveQuantity;
      setValue(reserveQuantity);
      setError("");
    }
  }, [reserveQuantity, revision, itemId]);

  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  async function persist() {
    if (!canEdit || busy.current) return;
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const initial = normalizeDigits(latestValue.current.trim());
    if (!quantityPattern.test(initial)) {
      setError("أدخل عددًا صحيحًا غير سالب حتى 22 رقمًا.");
      setSaved(false);
      return;
    }
    busy.current = true;
    setSaving(true);
    setError("");
    let failed = false;
    try {
      while (true) {
        if (editFocused.current) break;
        const raw = normalizeDigits(latestValue.current.trim());
        if (!quantityPattern.test(raw)) {
          setError("أدخل عددًا صحيحًا غير سالب حتى 22 رقمًا.");
          setSaved(false);
          failed = true;
          break;
        }
        const next = BigInt(raw).toString();
        if (next === persistedValue.current) {
          // The displayed value is already saved, no extra card revision.
          if (latestValue.current === raw) setValue(next);
          break;
        }
        const response = await api<{
          result: { reserveQuantity: string; revision: number };
        }>(`/companies/${companyId}/items/${itemId}/reserve-quantity`, {
          method: "PATCH",
          body: { revision: persistedRevision.current, reserveQuantity: next },
        });
        persistedRevision.current = response.result.revision;
        persistedValue.current = response.result.reserveQuantity;
        setSaved(true);
        void queryClient.invalidateQueries({ queryKey: ["item-options-list"] });
        void queryClient.invalidateQueries({ queryKey: ["items"] });
        if (latestValue.current === raw || latestValue.current === next) {
          latestValue.current = response.result.reserveQuantity;
          setValue(response.result.reserveQuantity);
          break;
        }
        // More taps happened during the request. Commit their latest total
        // in sequence with the returned revision; none of the taps are lost.
      }
    } catch (reason) {
      failed = true;
      setError(errorMessage(reason));
      setSaved(false);
      void queryClient.invalidateQueries({ queryKey: ["item-options-list"] });
    } finally {
      busy.current = false;
      setSaving(false);
      if (!failed && !editFocused.current &&
          quantityPattern.test(normalizeDigits(latestValue.current.trim())) &&
          BigInt(normalizeDigits(latestValue.current.trim())).toString() !== persistedValue.current) {
        scheduleSave(250);
      }
    }
  }

  function scheduleSave(delay: number) {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void persist();
    }, delay);
  }

  function changeBy(delta: -1 | 1) {
    if (!canEdit) return;
    const raw = normalizeDigits(latestValue.current.trim());
    const source = quantityPattern.test(raw) ? raw : persistedValue.current;
    const before = BigInt(source);
    const after = delta === -1 ? (before > 0n ? before - 1n : 0n) : before + 1n;
    if (after.toString().length > 22) {
      setError("الحد الأقصى لكمية الاحتياط 22 رقمًا.");
      return;
    }
    const next = after.toString();
    latestValue.current = next;
    editFocused.current = false;
    setValue(next);
    setError("");
    setSaved(false);
    scheduleSave(260);
  }

  const number = normalizeDigits(value.trim());
  const minusDisabled = !canEdit ||
    (quantityPattern.test(number) && BigInt(number) === 0n);
  return <div className="item-reserve-quick-edit">
    <div className="item-reserve-input-wrap">
      <button type="button" className="item-reserve-step-button"
        aria-label="زيادة كمية الاحتياط بمقدار واحد" title="زيادة 1"
        disabled={!canEdit} onClick={() => changeBy(1)}>+</button>
      <input type="text" inputMode="numeric" dir="ltr"
        aria-label="كمية احتياط بأصغر وحدة للصنف"
        title="كمية احتياط بأصغر وحدة مفعّلة — حفظ عند مغادرة الحقل أو الضغط Enter"
        value={value}
        disabled={!canEdit}
        onFocus={() => { editFocused.current = true; setSaved(false); }}
        onChange={event => {
          const typed = event.target.value;
          if (/[-−]/.test(normalizeDigits(typed))) {
            // Do not even display a negative reserve while editing.
            latestValue.current = "0";
            setValue("0");
            setError("كمية الاحتياط لا يمكن أن تقل عن صفر.");
            setSaved(false);
            return;
          }
          latestValue.current = typed;
          setValue(typed);
          setError("");
          setSaved(false);
        }}
        onBlur={() => {
          editFocused.current = false;
          scheduleSave(0);
        }}
        onKeyDown={event => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            editFocused.current = false;
            latestValue.current = persistedValue.current;
            setValue(persistedValue.current);
            setError("");
            if (timer.current !== null) {
              clearTimeout(timer.current);
              timer.current = null;
            }
            event.currentTarget.blur();
          }
        }}
      />
      <button type="button" className="item-reserve-step-button"
        aria-label="إنقاص كمية الاحتياط بمقدار واحد" title="إنقاص 1، دون النزول تحت الصفر"
        disabled={minusDisabled} onClick={() => changeBy(-1)}>−</button>
      {saving && <span className="muted item-reserve-saving" role="status">حفظ…</span>}
      {!saving && saved && !error && <span className="text-success item-reserve-saving" title="حُفظ الاحتياط">✓</span>}
    </div>
    {error && <small className="text-error" role="alert">{error}</small>}
  </div>;
}
