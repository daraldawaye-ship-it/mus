import { useEffect, useId, useRef, useState, type ComponentProps } from "react";
import { normalizeDigits } from "../../../packages/contracts/src/masters.ts";
import { Field } from "./ui";

/** Read a stored date without changing its day until the user edits it. */
export function expiryMonth(date: string | null | undefined): string {
  return date?.slice(0, 7) ?? "";
}

export function monthStartDate(month: string): string | null {
  if (!/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null;
  return `${month}-01`;
}

/** Numeric-only MM/YYYY entry works consistently across Chrome and phone browsers. */
export function expiryDigits(value: string): string {
  return normalizeDigits(value).replace(/[^0-9]/g, "");
}
export function monthIsComplete(month: string): boolean {
  return /^(0?[1-9]|1[0-2])$/.test(month);
}
/** Month 2..9 is unambiguous after one digit; 0/1 may begin a two-digit month. */
export function monthShouldAdvance(month: string): boolean {
  return monthIsComplete(month) && (month.length === 2 || /^[2-9]$/.test(month));
}
export function enteredMonthStart(month: string, year: string): string | null {
  if (!monthIsComplete(month) || !/^[0-9]{4}$/.test(year)) return null;
  return monthStartDate(`${year}-${month.padStart(2, "0")}`);
}
export type ExpiryUrgency = "none" | "expired" | "soon";

/** The date's month is valid through its last day, although stored as day 01. */
export function expiryUrgency(
  expiryDate: string | null | undefined,
  currentMonth: string,
): ExpiryUrgency {
  const expiry = /^(\d{4})-(0[1-9]|1[0-2])(?:-\d{2})?$/.exec(expiryDate ?? "");
  const current = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(currentMonth);
  if (!expiry || !current) return "none";
  const monthsRemaining =
    (Number(expiry[1]) - Number(current[1])) * 12 +
    Number(expiry[2]) - Number(current[2]);
  return monthsRemaining < 0 ? "expired" :
    monthsRemaining <= 1 ? "soon" : "none";
}

/** Local business date in Yemen, independent of the browser's time zone. */
function adenCurrentMonth(): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    year: "numeric", month: "2-digit", timeZone: "Asia/Aden",
  }).formatToParts(new Date());
  return (parts.find(part => part.type === "year")?.value ?? "") + "-" +
    (parts.find(part => part.type === "month")?.value ?? "");
}

function fromDate(date: string | null | undefined): { month: string; year: string } {
  return { month: date?.slice(5, 7) ?? "", year: date?.slice(0, 4) ?? "" };
}

type ExpiryMonthFieldProps = Omit<
  ComponentProps<typeof Field>, "type" | "value" | "onChange"
> & {
  value: string | null | undefined;
  onChange: (date: string | null) => void;
};

/**
 * Two numeric inputs instead of a locale-dependent native month control.
 * Selecting the month auto-focuses the year; only a complete valid date is
 * committed, with day 01. Historical dates retain their day until edited.
 */
export function ExpiryMonthField({
  value, onChange, id, label, className = "", hint, error, required,
  disabled, readOnly, onKeyDown, onFocus, onBlur, style, title, name,
}: ExpiryMonthFieldProps) {
  const generated = useId();
  const monthId = id ?? `${generated}-month`;
  const [month, setMonth] = useState(() => fromDate(value).month);
  const [year, setYear] = useState(() => fromDate(value).year);
  const lastIssued = useRef<string | null>(value || null);
  const yearInput = useRef<HTMLInputElement>(null);
  const monthInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const incoming = value || null;
    // An internal incomplete edit emits null; do not erase its in-progress
    // digits when the parent receives that null and re-renders.
    if (incoming === lastIssued.current) return;
    lastIssued.current = incoming;
    const parts = fromDate(value);
    setMonth(parts.month);
    setYear(parts.year);
  }, [value]);
  function commit(nextMonth: string, nextYear: string) {
    const next = enteredMonthStart(nextMonth, nextYear);
    lastIssued.current = next;
    onChange(next);
  }
  function editMonth(text: string) {
    const digits = expiryDigits(text).slice(0, 2);
    setMonth(digits);
    commit(digits, year);
    if (monthShouldAdvance(digits)) yearInput.current?.focus();
  }
  function editYear(text: string) {
    const digits = expiryDigits(text).slice(0, 4);
    setYear(digits);
    commit(month, digits);
  }
  const invalid = month !== "" && month.length === 2 && !monthIsComplete(month);
  const urgency = expiryUrgency(enteredMonthStart(month, year), adenCurrentMonth());

  return (
    <div className={["field floating-ready expiry-month-field", urgency === "none" ? "" : "expiry-month-field--" + urgency, className].filter(Boolean).join(" ")}
      data-label-raised="true" style={style} title={title}>
      <label htmlFor={monthId}>{label}</label>
      <div className="expiry-month-fields" dir="ltr">
        <input id={monthId} ref={monthInput} type="text" inputMode="numeric"
          autoComplete="off" placeholder="MM" maxLength={2}
          aria-label={`${label} — الشهر`} aria-invalid={!!error || invalid || undefined}
          aria-describedby={hint || error ? `${monthId}-hint` : undefined}
          required={required} disabled={disabled} readOnly={readOnly}
          value={month} onChange={event => editMonth(event.target.value)}
          onFocus={event => { event.target.select(); onFocus?.(event); }}
          onBlur={onBlur}
          onKeyDown={event => {
            if (event.key === "Enter" || (event.key === "ArrowRight" &&
              event.currentTarget.selectionStart === month.length)) {
              event.preventDefault();
              event.stopPropagation();
              yearInput.current?.focus();
            } else onKeyDown?.(event);
          }}
          onPaste={event => {
            const value = expiryDigits(event.clipboardData.getData("text"));
            const match = /^(\d{1,2})(\d{4})$/.exec(value);
            if (match && monthIsComplete(match[1]!)) {
              event.preventDefault();
              setMonth(match[1]!); setYear(match[2]!);
              commit(match[1]!, match[2]!);
              yearInput.current?.focus();
            }
          }}
        />
        <span className="expiry-month-separator" aria-hidden="true">/</span>
        <input id={`${monthId}-year`} ref={yearInput} type="text" inputMode="numeric"
          autoComplete="off" placeholder="YYYY" maxLength={4}
          aria-label={`${label} — السنة`}
          aria-describedby={hint || error ? `${monthId}-hint` : undefined}
          aria-invalid={!!error || undefined}
          name={name} required={required} disabled={disabled} readOnly={readOnly}
          value={year} onChange={event => editYear(event.target.value)}
          onFocus={event => { event.target.select(); onFocus?.(event); }}
          onBlur={onBlur}
          onKeyDown={event => {
            if (event.key === "ArrowLeft" && event.currentTarget.selectionStart === 0) {
              event.preventDefault();
              event.stopPropagation();
              monthInput.current?.focus();
            } else if (event.key === "Enter" && !enteredMonthStart(month, year)) {
              event.preventDefault();
              event.stopPropagation();
            } else onKeyDown?.(event);
          }}
        />
      </div>
      {(hint || error) && <small id={`${monthId}-hint`}
        className={error ? "text-error" : undefined}>{error ?? hint}</small>}
      {urgency !== "none" && (
        <small role="status" className={"expiry-month-alert expiry-month-alert--" + urgency}>
          {urgency === "expired" ? "انتهت صلاحية الصنف" : "قريب الانتهاء: خلال الشهر الحالي أو القادم"}
        </small>
      )}
    </div>
  );
}
