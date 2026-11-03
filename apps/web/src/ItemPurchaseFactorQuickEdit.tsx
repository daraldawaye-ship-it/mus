import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { normalizeDigits } from "../../../packages/contracts/src/index";
import { api } from "./api";
import { errorMessage } from "./phase2";

// Reference value only; never changes stock or pricing.
const validFactor = (value: string) =>
  /^\d{1,7}$/.test(value) && Number(value) >= 1 && Number(value) <= 1_000_000;

export function ItemPurchaseFactorQuickEdit({
  companyId, itemId, revision, purchaseFactor, canEdit,
}: {
  companyId: number; itemId: number; revision: number;
  purchaseFactor: number; canEdit: boolean;
}) {
  const queryClient = useQueryClient();
  const initial = String(purchaseFactor);
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const latest = useRef(initial);
  const persisted = useRef(initial);
  const currentRevision = useRef(revision);
  const busy = useRef(false);
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (revision < currentRevision.current || busy.current) return;
    if (revision === currentRevision.current && initial === persisted.current) return;
    currentRevision.current = revision;
    persisted.current = initial;
    if (!focused.current && timer.current === null) {
      latest.current = initial;
      setValue(initial);
      setError("");
    }
  }, [revision, initial, itemId]);

  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  function schedule(delay: number) {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void persist();
    }, delay);
  }

  async function persist() {
    if (!canEdit || busy.current) return;
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const raw = normalizeDigits(latest.current.trim());
    if (!validFactor(raw)) {
      setError("عامل الشراء عدد صحيح من 1 إلى 1000000.");
      setSaved(false);
      return;
    }
    busy.current = true;
    setSaving(true);
    setError("");
    let failed = false;
    try {
      while (!focused.current) {
        const nextRaw = normalizeDigits(latest.current.trim());
        if (!validFactor(nextRaw)) {
          setError("عامل الشراء عدد صحيح من 1 إلى 1000000.");
          setSaved(false);
          failed = true;
          break;
        }
        const next = String(Number(nextRaw));
        if (next === persisted.current) {
          if (latest.current === nextRaw) setValue(next);
          break;
        }
        const response = await api<{ result: { purchaseFactor: number; revision: number } }>(
          `/companies/${companyId}/items/${itemId}/purchase-factor`, {
            method: "PATCH",
            body: { revision: currentRevision.current, purchaseFactor: Number(next) },
          },
        );
        currentRevision.current = response.result.revision;
        persisted.current = String(response.result.purchaseFactor);
        setSaved(true);
        void queryClient.invalidateQueries({ queryKey: ["item-options-list"] });
        void queryClient.invalidateQueries({ queryKey: ["items"] });
        if (latest.current === nextRaw || latest.current === next) {
          latest.current = persisted.current;
          setValue(persisted.current);
          break;
        }
      }
    } catch (cause) {
      failed = true;
      setError(errorMessage(cause));
      setSaved(false);
      void queryClient.invalidateQueries({ queryKey: ["item-options-list"] });
    } finally {
      busy.current = false;
      setSaving(false);
      if (!failed && !focused.current &&
          validFactor(normalizeDigits(latest.current.trim())) &&
          String(Number(normalizeDigits(latest.current.trim()))) !== persisted.current) {
        schedule(250);
      }
    }
  }

  function changeBy(delta: -1 | 1) {
    if (!canEdit) return;
    const raw = normalizeDigits(latest.current.trim());
    const previous = validFactor(raw) ? Number(raw) : Number(persisted.current);
    const next = Math.min(1_000_000, Math.max(1, previous + delta));
    const text = String(next);
    latest.current = text;
    focused.current = false;
    setValue(text);
    setSaved(false);
    setError("");
    schedule(260);
  }

  const numeric = normalizeDigits(value.trim());
  return <div className="item-reserve-quick-edit">
    <div className="item-reserve-input-wrap">
      <button type="button" className="item-reserve-step-button"
        aria-label="زيادة عامل وحدة الشراء" title="زيادة 1"
        disabled={!canEdit || (validFactor(numeric) && Number(numeric) >= 1_000_000)}
        onClick={() => changeBy(1)}>+</button>
      <input type="text" inputMode="numeric" dir="ltr" value={value}
        aria-label="عامل وحدة الشراء" title="حفظ عند مغادرة الحقل أو الضغط Enter"
        disabled={!canEdit}
        onFocus={() => { focused.current = true; setSaved(false); }}
        onChange={event => {
          const raw = normalizeDigits(event.target.value);
          latest.current = raw;
          setValue(raw);
          setError("");
          setSaved(false);
        }}
        onBlur={() => { focused.current = false; schedule(0); }}
        onKeyDown={event => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            focused.current = false;
            latest.current = persisted.current;
            setValue(persisted.current);
            setError("");
            if (timer.current !== null) {
              clearTimeout(timer.current);
              timer.current = null;
            }
            event.currentTarget.blur();
          }
        }} />
      <button type="button" className="item-reserve-step-button"
        aria-label="إنقاص عامل وحدة الشراء" title="إنقاص 1 دون النزول عن 1"
        disabled={!canEdit || (validFactor(numeric) && Number(numeric) <= 1)}
        onClick={() => changeBy(-1)}>−</button>
      {saving && <span className="muted item-reserve-saving" role="status">حفظ…</span>}
      {!saving && saved && !error && <span className="text-success item-reserve-saving" title="حُفظ عامل الشراء">✓</span>}
    </div>
    {error && <small className="text-error" role="alert">{error}</small>}
  </div>;
}
