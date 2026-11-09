import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { normalizeDigits } from "../../../packages/contracts/src/index";
import { api } from "./api";
import { errorMessage } from "./phase2";

const validQuantity = (value: string | null) =>
  value === null || /^\d{1,22}$/.test(value);
const MAX_QUANTITY = 10n ** 22n - 1n;

/** NULL is intentionally different from zero: only NULL disables the alert.
 * Taps are serialized against the latest server revision, including rapid taps. */
export function ItemSpecialOrderQuantityQuickEdit({
  companyId, itemId, revision, orderAlertQuantity, canEdit,
}: {
  companyId: number; itemId: number; revision: number;
  orderAlertQuantity: string | null; canEdit: boolean;
}) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(orderAlertQuantity ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const desired = useRef<string | null>(orderAlertQuantity);
  const persisted = useRef<string | null>(orderAlertQuantity);
  const persistedRevision = useRef(revision);
  const busy = useRef(false);
  const focused = useRef(false);

  useEffect(() => {
    if (revision < persistedRevision.current || busy.current) return;
    if (revision === persistedRevision.current &&
        orderAlertQuantity === persisted.current) return;
    persisted.current = orderAlertQuantity;
    persistedRevision.current = revision;
    if (!focused.current) {
      desired.current = orderAlertQuantity;
      setValue(orderAlertQuantity ?? "");
      setError("");
    }
  }, [revision, orderAlertQuantity, itemId]);

  async function persist() {
    if (!canEdit || busy.current || focused.current) return;
    const initial = desired.current;
    if (!validQuantity(initial)) {
      setError("أدخل عددًا صحيحًا غير سالب أو اترك الحقل فارغًا.");
      return;
    }
    busy.current = true;
    setSaving(true);
    setSaved(false);
    setError("");
    let failed = false;
    try {
      while (!focused.current && desired.current !== persisted.current) {
        const next = desired.current;
        if (!validQuantity(next)) {
          setError("أدخل عددًا صحيحًا غير سالب حتى 22 رقمًا.");
          failed = true;
          break;
        }
        const canonical = next === null ? null : BigInt(next).toString();
        const response = await api<{
          result: { orderAlertQuantity: string | null; revision: number };
        }>("/companies/" + companyId + "/items/" + itemId + "/order-alert-quantity", {
          method: "PATCH",
          body: { revision: persistedRevision.current, orderAlertQuantity: canonical },
        });
        persisted.current = response.result.orderAlertQuantity;
        persistedRevision.current = response.result.revision;
        setSaved(true);
        void queryClient.invalidateQueries({ queryKey: ["item-order-draft-review"] });
        void queryClient.invalidateQueries({ queryKey: ["item-options-list"] });
        void queryClient.invalidateQueries({ queryKey: ["items"] });
        if (desired.current === next) {
          desired.current = persisted.current;
          setValue(persisted.current ?? "");
        }
      }
    } catch (cause) {
      failed = true;
      setSaved(false);
      setError(errorMessage(cause));
      void queryClient.invalidateQueries({ queryKey: ["item-order-draft-review"] });
    } finally {
      busy.current = false;
      setSaving(false);
      if (!failed && !focused.current && desired.current !== persisted.current) {
        void persist();
      }
    }
  }

  function step(delta: -1 | 1) {
    if (!canEdit) return;
    const normalized = normalizeDigits((desired.current ?? "").trim());
    const source = normalized && /^\d{1,22}$/.test(normalized)
      ? BigInt(normalized) : desired.current === null ? null : null;
    let next: string | null;
    if (delta === 1) {
      if (source !== null && source >= MAX_QUANTITY) return;
      next = source === null ? "0" : (source + 1n).toString();
    } else {
      if (source === null) return;
      next = source === 0n ? null : (source - 1n).toString();
    }
    desired.current = next;
    focused.current = false;
    setValue(next ?? "");
    setError("");
    setSaved(false);
    void persist();
  }

  const input = normalizeDigits(value.trim());
  const minusDisabled = !canEdit || value.trim() === "";
  const plusDisabled = !canEdit ||
    (/^\d{1,22}$/.test(input) && BigInt(input) >= MAX_QUANTITY);

  return <div className="item-reserve-quick-edit item-special-order-quick-edit">
    <div className="item-reserve-input-wrap">
      <button type="button" className="item-reserve-step-button"
        aria-label="زيادة كمية طلب الأصناف الخاصة بمقدار واحد"
        title="فارغ ← صفر ← 1 ← 2" disabled={plusDisabled}
        onClick={() => step(1)}>+</button>
      <input type="text" inputMode="numeric" dir="ltr" value={value}
        aria-label="كمية طلب الأصناف الخاصة بالوحدة الأولى"
        title="تركه فارغًا يوقف التنبيه؛ الصفر يُبقي التنبيه فعالًا"
        disabled={!canEdit}
        onFocus={() => { focused.current = true; setSaved(false); }}
        onChange={event => {
          const normalized = normalizeDigits(event.target.value);
          desired.current = normalized.trim() === "" ? null : normalized;
          setValue(normalized);
          setError("");
          setSaved(false);
        }}
        onBlur={() => { focused.current = false; void persist(); }}
        onKeyDown={event => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            focused.current = false;
            desired.current = persisted.current;
            setValue(persisted.current ?? "");
            setError("");
            event.currentTarget.blur();
          }
        }}
      />
      <button type="button" className="item-reserve-step-button"
        aria-label="إنقاص كمية طلب الأصناف الخاصة بمقدار واحد"
        title="1 ← صفر ← فارغ" disabled={minusDisabled}
        onClick={() => step(-1)}>−</button>
      {saving && <small className="muted item-reserve-saving">حفظ…</small>}
      {!saving && saved && !error && <small className="text-success item-reserve-saving">✓</small>}
    </div>
    {error && <small role="alert" className="text-error">{error}</small>}
  </div>;
}

const PERIODS = [
  { key:"ten-years", label:"إيقاف", description:"10 سنوات" },
  { key:"one-year", label:"إيقاف سنة", description:"سنة" },
  { key:"four-months", label:"إيقاف 4 أشهر", description:"4 أشهر" },
] as const;

export function ItemOrderStopQuickActions({
  companyId, itemId, itemName, revision, orderStoppedUntil, canEdit,
}: {
  companyId:number; itemId:number; itemName:string; revision:number;
  orderStoppedUntil:string|null; canEdit:boolean;
}) {
  const queryClient = useQueryClient();
  const currentRevision = useRef(revision);
  const [busy, setBusy] = useState(false);
  const [savedDate, setSavedDate] = useState<string | null>(null);
  const [error,setError] = useState("");
  useEffect(() => { if (revision >= currentRevision.current) currentRevision.current = revision; },
    [revision,itemId]);

  async function stop(period: typeof PERIODS[number]) {
    if (!canEdit || busy) return;
    const confirmed = window.confirm(
      "هل تؤكد إيقاف طلب الصنف «" + itemName + "» لمدة " + period.description +
      " من اليوم؟\nسيُحفظ تاريخ انتهاء الإيقاف في كرت الصنف." +
      "\nتنبيه «إذا كمية الطلب للأصناف الخاصة» سيستمر عند بلوغ الحد؛ لإيقافه اترك كمية الطلب فارغة.",
    );
    if (!confirmed) return;
    setBusy(true);
    setSavedDate(null);
    setError("");
    try {
      const response = await api<{
        result: { orderStoppedUntil:string; revision:number };
      }>("/companies/" + companyId + "/items/" + itemId + "/order-stop-period", {
        method: "PATCH",
        body: { revision: currentRevision.current, period: period.key },
      });
      currentRevision.current = response.result.revision;
      setSavedDate(response.result.orderStoppedUntil);
      void queryClient.invalidateQueries({ queryKey: ["item-order-draft-review"] });
      void queryClient.invalidateQueries({ queryKey: ["item-options-list"] });
      void queryClient.invalidateQueries({ queryKey: ["items"] });
    } catch (cause) {
      setError(errorMessage(cause));
      void queryClient.invalidateQueries({ queryKey: ["item-order-draft-review"] });
    } finally {
      setBusy(false);
    }
  }
  return <div className="item-order-draft-stop-actions">
    <div className="item-order-draft-stop-buttons">
      {PERIODS.map(period =>
        <button key={period.key} type="button" className="button button-secondary"
          disabled={!canEdit || busy} onClick={() => void stop(period)}>
          {period.label}
        </button>)}
    </div>
    <small className="muted">موقوف حتى: {savedDate ?? orderStoppedUntil ?? "غير موقوف"}</small>
    {error && <small className="text-error" role="alert">{error}</small>}
  </div>;
}
