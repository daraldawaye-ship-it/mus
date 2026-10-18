import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Smile, X } from "lucide-react";
import { Button } from "../ui";

export interface ChatEmojiPickerProps {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  obscured?: boolean;
  onOpenChange?: (open: boolean) => void;
}

const EMOJIS = [
  ["😊", "ابتسامة"], ["😀", "فرح"], ["😂", "ضحك"], ["😍", "إعجاب"], ["😎", "ثقة"], ["🤔", "تفكير"],
  ["🙂", "ابتسامة هادئة"], ["😅", "ابتسامة خجولة"], ["🥳", "احتفال"], ["😔", "حزن"], ["😮", "دهشة"], ["🙏", "شكر وتقدير"],
  ["👍", "موافق"], ["👎", "غير موافق"], ["👏", "تصفيق"], ["👋", "تحية"], ["🤝", "مصافحة"], ["💪", "تشجيع"],
  ["❤️", "قلب أحمر"], ["💙", "قلب أزرق"], ["💚", "قلب أخضر"], ["✨", "تألق"], ["🎉", "تهنئة"], ["🎊", "زينة الاحتفال"],
  ["🌹", "وردة"], ["🎁", "هدية"], ["🏆", "إنجاز"], ["⭐", "نجمة"], ["✅", "تم الإنجاز"], ["☑️", "تم التحقق"],
  ["💼", "أعمال"], ["📦", "طرد"], ["📝", "ملاحظة"], ["📅", "موعد"], ["⏰", "تذكير"], ["💡", "فكرة"],
] as const;
const GRID_COLUMNS = 6;

/** Inserts native emoji into the controlled draft without changing submission state. */
export function ChatEmojiPicker({
  textareaRef,
  value,
  onChange,
  disabled = false,
  obscured = false,
  onOpenChange,
}: ChatEmojiPickerProps) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef({ start: value.length, end: value.length });
  const restoreFrameRef = useRef<number | null>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  const blockedRef = useRef(disabled || obscured);
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const blocked = disabled || obscured;
  const visible = open && !blocked;

  useEffect(() => { onOpenChangeRef.current = onOpenChange; }, [onOpenChange]);
  useEffect(() => {
    blockedRef.current = blocked;
    if (blocked) {
      setOpen(false);
      setNotice("");
      if (restoreFrameRef.current !== null) cancelAnimationFrame(restoreFrameRef.current);
      restoreFrameRef.current = null;
    }
  }, [blocked]);
  useEffect(() => { onOpenChangeRef.current?.(visible); }, [visible]);
  useEffect(() => () => {
    if (restoreFrameRef.current !== null) cancelAnimationFrame(restoreFrameRef.current);
    onOpenChangeRef.current?.(false);
  }, []);

  useEffect(() => {
    if (!visible) return;
    const focusFrame = requestAnimationFrame(() => gridRef.current?.querySelector<HTMLButtonElement>("button")?.focus());
    const closeOutside = (event: Event) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      rootRef.current?.querySelector<HTMLButtonElement>(".chat-emoji-trigger")?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("focusin", closeOutside);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("focusin", closeOutside);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [visible]);

  const rememberSelection = () => {
    const textarea = textareaRef.current;
    if (textarea) selectionRef.current = { start: textarea.selectionStart, end: textarea.selectionEnd };
  };
  const insertEmoji = (emoji: string) => {
    const textarea = textareaRef.current;
    if (blocked || !textarea || textarea.disabled || textarea.readOnly) return;
    // Blurring a textarea preserves its DOM selection. The saved selection also
    // covers a controlled value update while focus is inside the picker.
    const selection = textarea.value === value
      ? { start: textarea.selectionStart, end: textarea.selectionEnd }
      : selectionRef.current;
    const start = Math.min(Math.max(0, selection.start), value.length);
    const end = Math.min(Math.max(start, selection.end), value.length);
    const nextValue = value.slice(0, start) + emoji + value.slice(end);
    const limit = textarea.maxLength >= 0 ? Math.min(4000, textarea.maxLength) : 4000;
    if (nextValue.length > limit) {
      setNotice("لا توجد مساحة كافية لإضافة الرمز. اختصر الرسالة أو استبدل جزءًا منها.");
      return;
    }
    const caret = start + emoji.length;
    selectionRef.current = { start: caret, end: caret };
    setNotice("");
    setOpen(false);
    onChange(nextValue);
    if (restoreFrameRef.current !== null) cancelAnimationFrame(restoreFrameRef.current);
    restoreFrameRef.current = requestAnimationFrame(() => {
      restoreFrameRef.current = null;
      const current = textareaRef.current;
      if (!current || blockedRef.current || current.disabled || current.readOnly || current.value !== nextValue) return;
      current.focus({ preventScroll: true });
      current.setSelectionRange(caret, caret);
    });
  };
  const moveGridFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(gridRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    let next: number;
    switch (event.key) {
      case "ArrowLeft": next = Math.min(buttons.length - 1, index + 1); break;
      case "ArrowRight": next = Math.max(0, index - 1); break;
      case "ArrowDown": next = Math.min(buttons.length - 1, index + GRID_COLUMNS); break;
      case "ArrowUp": next = Math.max(0, index - GRID_COLUMNS); break;
      case "Home": next = 0; break;
      case "End": next = buttons.length - 1; break;
      default: return;
    }
    event.preventDefault();
    buttons[next]?.focus();
  };

  return <div className="chat-emoji-picker" ref={rootRef} dir="rtl">
    <Button type="button" variant="ghost" size="compact" className="chat-emoji-trigger"
      aria-label="اختيار رمز تعبيري" title="اختيار رمز تعبيري" aria-haspopup="dialog" aria-expanded={visible}
      aria-controls={visible ? `${id}-popover` : undefined} disabled={blocked}
      onPointerDown={rememberSelection}
      onClick={() => {
        if (blocked) return;
        rememberSelection();
        setNotice("");
        setOpen(current => !current);
      }}><Smile size={20} aria-hidden="true" /></Button>
    {visible && <div id={`${id}-popover`} className="chat-emoji-popover" role="dialog"
      aria-labelledby={`${id}-title`} aria-describedby={`${id}-note`}>
      <div className="chat-emoji-header">
        <strong id={`${id}-title`}>الرموز التعبيرية</strong>
        <Button type="button" variant="ghost" size="compact" aria-label="إغلاق الرموز التعبيرية"
          onClick={() => { setOpen(false); rootRef.current?.querySelector<HTMLButtonElement>(".chat-emoji-trigger")?.focus(); }}><X size={16} aria-hidden="true" /></Button>
      </div>
      <div className="chat-emoji-grid" ref={gridRef} role="group" aria-label="اختر رمزًا تعبيريًا" onKeyDown={moveGridFocus}>
        {EMOJIS.map(([emoji, label]) => <button type="button" className="chat-emoji-option" key={emoji}
          aria-label={label} title={label} onClick={() => insertEmoji(emoji)}><span aria-hidden="true">{emoji}</span></button>)}
      </div>
      <p id={`${id}-note`} className="chat-emoji-note" role="status">
        {notice || "يُضاف الرمز في موضع المؤشر داخل رسالتك."}
      </p>
    </div>}
  </div>;
}
