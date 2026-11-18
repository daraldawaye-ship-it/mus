import { useEffect, useId, useRef, useState } from "react";
import { Calculator, Check, Delete, X } from "lucide-react";
import "./NumericPadField.css";

/** Normalize Arabic/Persian digits without ever converting through floating point. */
export function numericPadDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/g, digit =>
    String(digit.charCodeAt(0) - (digit.charCodeAt(0) <= 0x669 ? 0x660 : 0x6f0)))
    .replace(/٫/g, ".").replace(/−/g, "-");
}
export function numericPadValid(
  raw: string, allowDecimal: boolean, allowNegative: boolean,
  maxIntegerDigits: number, maxDecimals: number,
): boolean {
  const value = numericPadDigits(raw);
  if (value === "") return true;
  if (!allowNegative && value.includes("-")) return false;
  if (!allowDecimal && value.includes(".")) return false;
  if (!/^-?(?:\d*)(?:\.\d*)?$/.test(value)) return false;
  const unsigned = value.startsWith("-") ? value.slice(1) : value;
  const [whole, fraction = ""] = unsigned.split(".");
  return whole.length <= maxIntegerDigits && fraction.length <= maxDecimals;
}
export function numericPadCommit(raw: string): string {
  const value = numericPadDigits(raw).trim();
  const negative = value.startsWith("-");
  const unsigned = (negative ? value.slice(1) : value).replace(/^\./, "0.");
  const [whole = "", fraction] = unsigned.split(".");
  const normalizedWhole = whole.replace(/^0+(?=\d)/, "") || "0";
  const normalizedFraction = fraction?.replace(/0+$/, "");
  const result = normalizedWhole + (normalizedFraction ? "." + normalizedFraction : "");
  return negative && !/^0(?:\.0*)?$/.test(result) ? "-" + result : result;
}

export type NumericPadFieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  readOnly?: boolean;
  allowNegative?: boolean;
  allowDecimal?: boolean;
  maxIntegerDigits?: number;
  maxDecimals?: number;
  confirmText?: string;
  openButtonLabel?: string;
  className?: string;
};

/** A reusable field. Clicking the keypad icon edits a temporary draft;
 * cancel/backdrop/Escape do not commit anything to the external field. */
export function NumericPadField({
  label, value, onChange, id, placeholder = "0", disabled = false,
  readOnly = false, allowNegative = true, allowDecimal = true,
  maxIntegerDigits = 18, maxDecimals = 4, confirmText = "موافق",
  openButtonLabel = "فتح لوحة الأرقام", className = "",
}: NumericPadFieldProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const modal = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("0");
  const [error, setError] = useState("");

  useEffect(() => {
    const dialog = modal.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
    return () => { if (dialog.open) dialog.close(); };
  }, [open]);

  const close = () => {
    modal.current?.close();
    setOpen(false);
    setError("");
    opener.current?.focus();
  };
  const launch = () => {
    const initial = numericPadDigits(value).trim();
    setDraft(numericPadValid(initial, allowDecimal, allowNegative, maxIntegerDigits, maxDecimals)
      ? initial || "0" : "0");
    setError("");
    setOpen(true);
  };
  const enter = (key: string) => {
    setError("");
    if (key === "clear") { setDraft("0"); return; }
    if (key === "delete") {
      setDraft(current => current.length <= 1 || (current.length === 2 && current.startsWith("-"))
        ? "0" : current.slice(0, -1));
      return;
    }
    setDraft(current => {
      if (key === ".") {
        if (!allowDecimal || current.includes(".") || maxDecimals === 0) return current;
        return current + ".";
      }
      const next = current === "0" ? key : current === "-0" ? "-" + key : current + key;
      return numericPadValid(next, allowDecimal, allowNegative, maxIntegerDigits, maxDecimals)
        ? next : current;
    });
  };
  const toggleSign = () => {
    if (!allowNegative) return;
    setDraft(current => current.startsWith("-") ? current.slice(1) || "0" : "-" + (current || "0"));
  };
  const accept = () => {
    if (!numericPadValid(draft, allowDecimal, allowNegative, maxIntegerDigits, maxDecimals)) {
      setError("قيمة غير صالحة"); return;
    }
    onChange(numericPadCommit(draft));
    close();
  };

  return <div className={`numeric-pad-field ${className}`} dir="rtl">
    <label htmlFor={fieldId} className="numeric-pad-label">{label}</label>
    <div className="numeric-pad-input-row">
      <input id={fieldId} type="text" dir="ltr"
        inputMode={allowDecimal ? "decimal" : "numeric"}
        value={value} placeholder={placeholder} disabled={disabled} readOnly={readOnly}
        autoComplete="off" spellCheck={false}
        onChange={event => {
          const next = numericPadDigits(event.target.value);
          if (numericPadValid(next, allowDecimal, allowNegative, maxIntegerDigits, maxDecimals))
            onChange(next);
        }}/>
      <button ref={opener} type="button" className="numeric-pad-open"
        disabled={disabled || readOnly} onClick={launch} title={openButtonLabel}
        aria-label={openButtonLabel} aria-haspopup="dialog" aria-expanded={open}>
        <Calculator size={17} aria-hidden="true"/>
      </button>
    </div>
    <dialog ref={modal} className="numeric-pad-dialog" dir="rtl"
      aria-label={`لوحة الأرقام — ${label}`}
      onCancel={event => { event.preventDefault(); close(); }}
      onClose={() => setOpen(false)}
      onClick={event => { if (event.target === event.currentTarget) close(); }}>
      <div className="numeric-pad-shell">
        <div className="numeric-pad-display" dir="ltr" aria-live="polite">
          <button type="button" className="numeric-pad-clear"
            onClick={() => enter("clear")} title="مسح الرقم" aria-label="مسح الرقم">
            <X size={15} aria-hidden="true"/>
          </button>
          <span className="numeric-pad-value">{draft || "0"}</span>
          <button type="button" dir="rtl"
            className={`numeric-pad-sign ${draft.startsWith("-") ? "negative" : "positive"}`}
            aria-label={`الإشارة ${draft.startsWith("-") ? "سالبة" : "موجبة"}؛ اضغط للتبديل`}
            aria-pressed={draft.startsWith("-")} disabled={!allowNegative}
            onClick={toggleSign} title="تبديل موجب وسالب">
            <span aria-hidden="true">{draft.startsWith("-") ? "−" : "+"}</span>
            {draft.startsWith("-") ? "سالب" : "موجب"}
          </button>
        </div>
        <div className="numeric-pad-keys" dir="ltr">
          {["1","2","3","4","5","6","7","8","9"].map(key =>
            <button type="button" key={key} onClick={() => enter(key)}>{key}</button>)}
          <button type="button" onClick={() => enter(".")} disabled={!allowDecimal || maxDecimals === 0} aria-label="فاصلة عشرية">.</button>
          <button type="button" onClick={() => enter("0")}>0</button>
          <button type="button" onClick={() => enter("delete")} className="numeric-pad-backspace" aria-label="حذف آخر رقم"><Delete size={23}/></button>
        </div>
        {error && <p className="numeric-pad-error" role="alert">{error}</p>}
        <div className="numeric-pad-actions">
          <button type="button" className="numeric-pad-cancel" onClick={close}>إلغاء</button>
          <button type="button" className="numeric-pad-confirm" onClick={accept}><Check size={17}/>{confirmText}</button>
        </div>
      </div>
    </dialog>
  </div>;
}
