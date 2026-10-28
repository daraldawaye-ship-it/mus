import "./ChatImagePicker.css";
import { useRef, useState, type ChangeEvent } from "react";
import { ImagePlus, X } from "lucide-react";
import { api } from "../api";
import type { ChatScope } from "../../../../packages/contracts/src/chat";

export interface ChatAttachedImage { id: string; preview: string; }
interface UploadedAsset { id: string; }
function resizeImage(bitmap: ImageBitmap, edge: number, quality: number) {
  const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("المتصفح لا يدعم تجهيز الصورة.");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const webp = canvas.toDataURL("image/webp", quality);
  return webp.startsWith("data:image/webp;") ? webp : canvas.toDataURL("image/jpeg", quality);
}

/** The uploaded picture is private until a message references its ID. */
export function ChatImagePicker({ scope, companyId, enabled, disabled, value, onChange }: {
  scope: ChatScope; companyId?: number; enabled: boolean; disabled?: boolean;
  value: ChatAttachedImage | null; onChange: (value: ChatAttachedImage | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !enabled || disabled || busy) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 10 * 1024 * 1024) {
      setError("اختر صورة JPG أو PNG أو WebP بحجم لا يزيد عن 10 ميجابايت.");
      return;
    }
    setError(""); setBusy(true);
    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await createImageBitmap(file);
      if (bitmap.width * bitmap.height > 30_000_000) throw new Error("أبعاد الصورة كبيرة جدًا.");
      const original = resizeImage(bitmap, 1440, 0.8);
      if (original.length > 2_600_000) throw new Error("الصورة كبيرة بعد تجهيزها؛ اختر صورة أصغر.");
      const result = await api<UploadedAsset>("/media", {
        method: "POST",
        body: {
          purpose: "chat", companyId: scope === "company" ? companyId : null,
          original, thumbnail: resizeImage(bitmap, 240, 0.65),
        },
      });
      onChange({ id: result.id, preview: original });
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذر رفع الصورة.");
    } finally { bitmap?.close(); setBusy(false); }
  };
  return <div className="chat-image-picker">
    <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" hidden
      aria-label="اختر صورة لإرفاقها بالدردشة" onChange={event => void upload(event)}
      disabled={disabled || !enabled || busy} />
    <button type="button" className="chat-image-attach-button"
      title={!enabled ? "إرفاق الصور معطّل من الكنترول" : "إرفاق صورة"}
      aria-label="إرفاق صورة" disabled={!enabled || disabled || busy}
      onClick={() => input.current?.click()}><ImagePlus size={19}/></button>
    {busy && <small role="status">جارٍ رفع الصورة…</small>}
    {value && <div className="chat-image-selected"><img src={value.preview} alt="معاينة الصورة المراد إرسالها"/>
      <button type="button" title="إزالة الصورة" aria-label="إزالة الصورة" onClick={() => onChange(null)}><X size={15}/></button>
    </div>}
    {error && <small className="chat-image-error" role="alert">{error}</small>}
  </div>;
}
