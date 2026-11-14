import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, Copy, ExternalLink, RotateCcw, X } from "lucide-react";
import "./DesignLibraryWebartShared.css";

// Shared only by the three on-demand WebArt galleries. All examples are local.
export function Example({ code, title, note, source, wide = false, children }: {
  code: string; title: string; note: string; source?: string; wide?: boolean; children: ReactNode;
}) {
  const [copyState, setCopyState] = useState<"idle" | "ok" | "failed">("idle");
  const copy = async () => {
    try { await navigator.clipboard.writeText(`${title} — ${code}`); setCopyState("ok"); }
    catch { setCopyState("failed"); }
  };
  return <article id={`design-${code}`} className={`design-sample wa-example${wide ? " wa-wide" : ""}`}>
    <header className="design-sample-heading">
      <div><strong>{title}</strong><span className="design-sample-code">{code}</span></div>
      <button type="button" className="design-copy" onClick={() => void copy()} aria-label={`نسخ ${title}`}>
        {copyState === "ok" ? <Check size={13} /> : <Copy size={13} />}{copyState === "ok" ? "نُسخ" : "نسخ الاسم"}
      </button>
    </header>
    <div className="design-sample-body">{children}</div>
    <p className="design-sample-note">{note}</p>
    {source && <a className="wa-source-link" href={source} target="_blank" rel="noopener noreferrer">مرجع الفكرة <ExternalLink size={11} /></a>}
    {copyState === "failed" && <label className="wa-field">انسخ الاسم من هنا<input readOnly value={`${title} — ${code}`} onFocus={e => e.currentTarget.select()} /></label>}
    <span className="wa-sr-only" role="status">{copyState === "ok" ? "نُسخ اسم النموذج ورمزه." : ""}</span>
  </article>;
}

export function Group({ title, children }: { title: string; children: ReactNode }) {
  return <section className="design-group"><div className="design-group-heading"><h2>{title}</h2></div><div className="design-sample-grid">{children}</div></section>;
}

export function SectionIntro({ children, onReset }: { children: ReactNode; onReset: () => void }) {
  return <div className="wa-intro"><div><p>{children}</p><small>نماذج عربية ببيانات تجريبية؛ جرّبها ثم انسخ الاسم والرمز لطلب استخدامها.</small></div>
    <button type="button" className="button button-secondary button-compact" onClick={onReset}><RotateCcw size={13} /> إعادة التجارب</button>
  </div>;
}

export function DemoDialog({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return <dialog ref={ref} className="wa-dialog" aria-labelledby={titleId}
    onCancel={e => { e.preventDefault(); onClose(); }} onClose={onClose}
    onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="wa-dialog-content"><header><h3 id={titleId}>{title}</h3><button type="button" className="button button-secondary button-compact" aria-label="إغلاق النافذة" onClick={onClose}><X size={16} /></button></header>
      <p className="wa-muted">معاينة تجريبية داخل المكتبة.</p>{children}
    </div>
  </dialog>;
}
