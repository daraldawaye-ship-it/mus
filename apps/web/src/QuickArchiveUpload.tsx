import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "./api";
import { usePageDirectory } from "./page-directory";
import { currentDeviceKind } from "./device-kind";
import { Button, Dialog, Notice } from "./ui";

type Row = {
  id: number; file: File; category: string; title: string;
  progress: number; state: "ready" | "uploading" | "saved" | "failed"; error: string;
};
const categories = ["فاتورة", "سند", "وصفة طبية", "أوراق رسمية", "آخر"];
const extensions = "jpg,jpeg,png,webp,gif,pdf,zip,rar,7z,doc,docx,xls,xlsx,ppt,pptx,txt,csv,rtf,mp3,wav,ogg,m4a,aac,flac,mp4,webm,mov";
const maximumBytes = 25 * 1024 * 1024;

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string"
      ? resolve(reader.result) : reject(new Error("تعذر قراءة الملف"));
    reader.onerror = () => reject(new Error("تعذر قراءة الملف"));
    reader.readAsDataURL(file);
  });
}
async function prepareFile(file: File): Promise<{ dataUrl: string; filename: string }> {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!extensions.split(",").includes(extension)) throw new Error("صيغة الملف غير مدعومة");
  if (!file.size || file.size > maximumBytes) throw new Error("الحجم المسموح حتى 25 ميجابايت لكل ملف");
  // GIF remains unchanged so animated images retain their original frames.
  if (!["jpg", "jpeg", "png", "webp"].includes(extension)) {
    return { dataUrl: await readAsDataUrl(file), filename: file.name };
  }
  const bitmap = await createImageBitmap(file);
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 65_000_000)
      throw new Error("أبعاد الصورة كبيرة جدًا");
    // A4 at 300dpi: 2480 × 3508, preserving orientation and aspect ratio.
    const landscape = bitmap.width > bitmap.height;
    const widthLimit = landscape ? 3508 : 2480;
    const heightLimit = landscape ? 2480 : 3508;
    const scale = Math.min(1, widthLimit / bitmap.width, heightLimit / bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("المتصفح لا يدعم ضغط الصور");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const compressed = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("تعذر تحويل الصورة إلى WebP")), "image/webp", 0.88));
    if (compressed.size > maximumBytes) throw new Error("الصورة كبيرة جدًا بعد الضغط");
    return {
      dataUrl: await readAsDataUrl(compressed),
      filename: file.name.replace(/\.[^.]+$/, "") + ".webp",
    };
  } finally { bitmap.close(); }
}

function uploadWithProgress(body: unknown, token: string, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/archive/files");
    xhr.withCredentials = true;
    xhr.setRequestHeader("Accept", "application/json");
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.setRequestHeader("X-CSRF-Token", token);
    xhr.setRequestHeader("X-Alraesy-Device", currentDeviceKind());
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) onProgress(Math.min(99, Math.round(e.loaded / e.total * 100)));
    };
    xhr.onerror = () => reject(new Error("انقطع الاتصال أثناء الرفع"));
    xhr.onabort = () => reject(new Error("توقف الرفع"));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { onProgress(100); resolve(); return; }
      let error = "تعذر حفظ المرفق";
      try { error = JSON.parse(xhr.responseText)?.error?.message || error; } catch { /* unexpected response */ }
      reject(new Error(error));
    };
    xhr.send(JSON.stringify(body));
  });
}

/** Public archive quick entry: one record per file, content/evidence can be edited in /archive later. */
export function QuickArchiveUpload() {
  const { user, csrf, offlineMode } = useSession();
  const directory = usePageDirectory();
  const canCreate = !!directory.data?.some(page =>
    page.key === "public.archive" && page.enabled && page.actionAccess.create);
  const cache = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const serial = useRef(1);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const allSaved = rows.length > 0 && rows.every(row => row.state === "saved");
  const hasPending = rows.some(row => row.state !== "saved");
  if (!user || !canCreate) return null;
  function patch(id: number, change: Partial<Row>) {
    setRows(old => old.map(row => row.id === id ? { ...row, ...change } : row));
  }
  async function save() {
    if (busy) return;
    if (!csrf || offlineMode) { setFeedback("يجب الاتصال بالموقع وتسجيل الدخول قبل رفع الملفات"); return; }
    const pending = rows.filter(row => row.state !== "saved");
    if (!pending.length) return;
    setBusy(true); setFeedback("");
    let saved = 0;
    for (const row of pending) {
      if (!row.title.trim()) { patch(row.id, { state: "failed", error: "أدخل اسم المرفق" }); continue; }
      patch(row.id, { state: "uploading", progress: 0, error: "" });
      try {
        const prepared = await prepareFile(row.file);
        await uploadWithProgress({
          companyId: null, category: row.category, title: row.title.trim(),
          filename: prepared.filename, dataUrl: prepared.dataUrl,
        }, csrf, percent => patch(row.id, { progress: percent }));
        patch(row.id, { state: "saved", progress: 100 }); saved++;
      } catch (cause) {
        patch(row.id, { state: "failed", error: cause instanceof Error ? cause.message : "تعذر حفظ المرفق" });
      }
    }
    if (saved) await cache.invalidateQueries({ queryKey: ["archive"] });
    setFeedback(saved ? `تم حفظ ${saved} مرفق في الأرشيف العام. يمكن استكمال الشرح والاستدلال من صفحة الأرشيف.` : "تعذر حفظ المرفقات؛ راجع الأخطاء أسفل الملفات");
    setBusy(false);
  }
  return <>
    <Button variant="secondary" onClick={() => { setOpen(true); setFeedback(""); }}>إضافة مرفق</Button>
    <Dialog open={open} title="إضافة مرفقات إلى الأرشيف العام" onClose={() => { if (!busy) setOpen(false); }}>
      <div className="form-stack">
        <input ref={input} type="file" multiple accept={extensions.split(",").map(e => "." + e).join(",")}
          disabled={busy} onChange={event => {
            const files = Array.from(event.target.files ?? []);
            setRows(previous => [...previous, ...files.map(file => ({
              id: serial.current++, file, category: "آخر", title: file.name.replace(/\.[^.]+$/, ""),
              progress: 0, state: "ready" as const, error: "",
            }))]);
            event.target.value = "";
          }} />
        <small>اختيار متعدد. الصور الثابتة تتحول إلى WebP بدون قص وبحد أبعاد A4 بدقة 300dpi؛ GIF يُضغط تلقائيًا مع الحفاظ على الحركة، وبقية الملفات دون تغيير. الحد 25 ميجابايت للملف.</small>
        {rows.map(row => <div key={row.id} className="card" style={{ padding: 12, display: "grid", gap: 8 }}>
          <strong style={{ overflowWrap: "anywhere" }}>{row.file.name}</strong>
          <label>نوع المرفق
            <select value={row.category} disabled={busy || row.state === "saved"}
              onChange={e => patch(row.id, { category: e.target.value })}>
              {categories.map(value => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label>اسم المرفق
            <input value={row.title} maxLength={300} disabled={busy || row.state === "saved"}
              onChange={e => patch(row.id, { title: e.target.value })} />
          </label>
          <progress value={row.progress} max={100} style={{ width: "100%" }} />
          <small>{row.state === "saved" ? "تم الحفظ" : row.state === "uploading" ? `جارٍ الرفع ${row.progress}%` : row.error || "جاهز للرفع"}</small>
          {!busy && row.state !== "saved" &&
            <Button variant="ghost" size="compact" onClick={() => setRows(old => old.filter(value => value.id !== row.id))}>إزالة من القائمة</Button>}
        </div>)}
        {feedback && <Notice>{feedback}</Notice>}
        <div className="form-actions">
          {allSaved
            ? <span role="status" aria-live="polite" style={{display:"inline-flex",alignItems:"center",fontWeight:700,padding:"8px 12px"}}>✓ تم الحفظ</span>
            : <Button onClick={() => void save()} disabled={busy || !hasPending}>{busy ? "جارٍ الرفع…" : "حفظ المرفقات"}</Button>}
          <Button variant="secondary" disabled={busy} onClick={() => { setOpen(false); setRows([]); }}>إغلاق</Button>
        </div>
      </div>
    </Dialog>
  </>;
}
