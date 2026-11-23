import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { normalizeDigits } from "../../../packages/contracts/src/index";
import { api, sessionRequiresLogin, useScopeGuard } from "./api";
import { isOfflineNow } from "./connection-mode";
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
const THREE_DAY_PERIOD = { key:"three-days", label:"إيقاف 3 أيام", description:"3 أيام" } as const;
type OrderStopPeriod = typeof PERIODS[number] | typeof THREE_DAY_PERIOD;
const adenDay = new Intl.DateTimeFormat("sv-SE", {
  timeZone:"Asia/Aden", year:"numeric", month:"2-digit", day:"2-digit",
});
export function orderStopIsActive(date:string|null, now = new Date()) {
  if (!date) return false;
  const parts=adenDay.formatToParts(now);
  const today=["year","month","day"].map(part=>parts.find(value=>value.type===part)?.value).join("-");
  // Same rule as the stock planning filter: today and earlier are not stopped.
  return date > today;
}

export function ItemOrderStopQuickActions({
  companyId, itemId, itemName, revision, orderStoppedUntil, canEdit, includeThreeDays = false, inlineStatus = false, compact = false, readRevision = revision,
}: {
  companyId:number; itemId:number; itemName:string; revision:number;
  orderStoppedUntil:string|null; canEdit:boolean; includeThreeDays?:boolean; inlineStatus?:boolean; compact?:boolean; readRevision?:number;
}) {
  const queryClient = useQueryClient();
  const guard=useScopeGuard(`item-order-stop:${companyId}:${itemId}`);
  const currentRevision = useRef(revision);
  const [busy, setBusy] = useState(false);
  const [savedStop,setSavedStop]=useState<{date:string|null;revision:number}|null>(null);
  const inFlight=useRef(false);
  const [error,setError] = useState("");
  useEffect(() => { if (revision >= currentRevision.current) currentRevision.current = revision; },
    [revision,itemId]);

  async function stop(period: OrderStopPeriod | "resume") {
    if (!canEdit || inFlight.current || (compact && (!guard.isCurrent() || isOfflineNow() || sessionRequiresLogin()))) return;
    const confirmed = window.confirm(period==="resume" ?
      "هل تؤكد إلغاء إيقاف طلب الصنف «" + itemName + "»؟" :
      "هل تؤكد إيقاف طلب الصنف «" + itemName + "» لمدة " + period.description +
      " من اليوم؟\nسيُحفظ تاريخ انتهاء الإيقاف في كرت الصنف." +
      "\nتنبيه «إذا كمية الطلب للأصناف الخاصة» سيستمر عند بلوغ الحد؛ لإيقافه اترك كمية الطلب فارغة.",
    );
    if (!confirmed) return;
    inFlight.current=true;
    setBusy(true);
    setError("");
    try {
      const response = await api<{
        result: { itemId:number; orderStoppedUntil:string|null; revision:number };
      }>("/companies/" + companyId + "/items/" + itemId + "/order-stop-period", {
        method: "PATCH",
        body: { revision: currentRevision.current, period: period==="resume"?"resume":period.key },
        ...(compact ? {signal:guard.signal} : {}),
      });
      if (compact && !guard.isCurrent()) return;
      if(response.result.itemId!==itemId ||
        (period==="resume" ? response.result.orderStoppedUntil!==null : !response.result.orderStoppedUntil))
        throw new Error("تعذر تأكيد حالة إيقاف الصنف.");
      currentRevision.current = response.result.revision;
      setSavedStop({date:response.result.orderStoppedUntil,revision:response.result.revision});
      void queryClient.invalidateQueries({ queryKey: ["item-order-draft-review"] });
      void queryClient.invalidateQueries({ queryKey: ["item-options-list"] });
      void queryClient.invalidateQueries({ queryKey: ["items"] });
      if (compact) void queryClient.invalidateQueries({queryKey:["work-panel-compact-card"]});
    } catch (cause) {
      if (compact && !guard.isCurrent()) return;
      setError(errorMessage(cause));
      void queryClient.invalidateQueries({ queryKey: ["item-order-draft-review"] });
      if (compact) void queryClient.invalidateQueries({queryKey:["work-panel-compact-card"]});
    } finally {
      inFlight.current=false;
      if (!compact || guard.isCurrent()) setBusy(false);
    }
  }
  const stopDate = savedStop && savedStop.revision>=readRevision ? savedStop.date : orderStoppedUntil;
  const stopped = orderStopIsActive(stopDate);
  if (compact) return <div className="work-panel-compact-stop">
    <button type="button" className="button button-secondary button-compact" disabled={!canEdit||busy}
      title={stopped? `موقوف حتى ${stopDate}` : "إيقاف طلب الصنف"}
      onClick={() => void stop(orderStopIsActive(stopDate)?"resume":PERIODS[0])}>
      {busy?"جارٍ الحفظ…":stopped?"إلغاء الإيقاف":"إيقاف"}
    </button>
    {stopped && <small role="status">حتى <bdi>{stopDate}</bdi></small>}
    {error && <small className="text-error" role="alert">{error}</small>}
  </div>;
  return <div className={inlineStatus ? "item-order-draft-stop-actions item-options-inline-stop" : "item-order-draft-stop-actions"}>
    <div className="item-order-draft-stop-buttons">
      {(includeThreeDays ? [...PERIODS, THREE_DAY_PERIOD] : PERIODS).map(period =>
        <button key={period.key} type="button" className="button button-secondary"
          disabled={!canEdit || busy} onClick={() => void stop(period)}>
          {period.label}
        </button>)}
      {inlineStatus && <small className="muted">{stopDate ? <>حتى <bdi>{stopDate}</bdi></> : "غير موقوف"}</small>}
    </div>
    {!inlineStatus && <small className="muted">موقوف حتى: {stopDate ?? "غير موقوف"}</small>}
    {error && <small className="text-error" role="alert">{error}</small>}
  </div>;
}
