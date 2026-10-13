import { useRef, useState } from "react";
import type { CompanyContext } from "../../../packages/contracts/src/index";
import { api, useScopeGuard } from "./api";
import { errorMessage } from "./phase2";
import { Button, Dialog, Notice } from "./ui";

type CompositionRow = { arabicName: string; englishName: string };
type ImportFile = {
  format: "tijara-compositions-v1";
  count: number;
  sourceColumn?: string;
  items: CompositionRow[];
};
const key = (row: CompositionRow) =>
  JSON.stringify([row.arabicName.trim().toLowerCase(), row.englishName.trim().toLowerCase()]);

export function CompositionImportDialog({
  context, onClose, onImported,
}: {
  context: CompanyContext;
  onClose: () => void;
  onImported: () => void;
}) {
  const companyId = context.company.id;
  const guard = useScopeGuard(`company:${companyId}:compositions:import`);
  const [payload, setPayload] = useState<ImportFile | null>(null);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [running, setRunning] = useState(false);
  const [offset, setOffset] = useState(0);
  const [created, setCreated] = useState(0);
  const [skipped, setSkipped] = useState(0);
  const pause = useRef(false);
  const finished = !!payload && offset >= payload.items.length;

  async function readFile(file: File | undefined) {
    if (!file || running) return;
    setError(""); setNotice(""); setPayload(null); setConfirmed(false);
    setOffset(0); setCreated(0); setSkipped(0); setFileName(file.name);
    if (file.size > 12_000_000) {
      setError("ملف التراكيب أكبر من 12 ميجابايت."); return;
    }
    try {
      const value: unknown = JSON.parse(await file.text());
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("ملف الاستيراد غير صالح.");
      const data = value as Partial<ImportFile>;
      if (
        data.format !== "tijara-compositions-v1" ||
        !Array.isArray(data.items) || !data.items.length ||
        data.items.length > 50000 || data.count !== data.items.length
      ) throw new Error("ملف التراكيب غير صالح؛ اختر الملف المجهز للاستيراد.");
      const unique = new Set<string>();
      for (const row of data.items) {
        if (!row || typeof row.arabicName !== "string" ||
            typeof row.englishName !== "string" ||
            !row.arabicName.trim() || !row.englishName.trim() ||
            row.arabicName.trim().length > 240 ||
            row.englishName.trim().length > 240)
          throw new Error("بعض الأسماء فارغة أو تتجاوز 240 حرفًا.");
        const normalized = key(row);
        if (unique.has(normalized)) throw new Error("توجد تراكيب مكررة في الملف.");
        unique.add(normalized);
      }
      setPayload(data as ImportFile);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function run() {
    if (!payload || !confirmed || running || finished) return;
    pause.current = false; setRunning(true); setError(""); setNotice("");
    let position = offset, added = created, existing = skipped;
    try {
      while (position < payload.items.length && !pause.current) {
        const batch = payload.items.slice(position, position + 70);
        const response = await api<{ created: number; skipped: number }>(
          `/companies/${companyId}/item-compositions/import-batch`, {
            method: "POST", signal: guard.signal,
            body: { format: payload.format, items: batch },
          },
        );
        if (!guard.isCurrent()) return;
        position += batch.length; added += response.created;
        existing += response.skipped;
        setOffset(position); setCreated(added); setSkipped(existing);
      }
      if (!guard.isCurrent()) return;
      onImported();
      setNotice(position >= payload.items.length
        ? `اكتمل الاستيراد: أُضيف ${added.toLocaleString("ar-YE")} تركيبًا، وتجاوز ${existing.toLocaleString("ar-YE")} موجودًا.`
        : "تم إيقاف الاستيراد مؤقتًا؛ يمكنك الاستكمال.");
    } catch (reason) {
      if (guard.isCurrent())
        setError(`توقف الاستيراد عند السجل ${position + 1}: ${errorMessage(reason)}. يمكنك المحاولة مجددًا دون مضاعفة السجلات السابقة.`);
    } finally {
      if (guard.isCurrent()) setRunning(false);
    }
  }

  return (
    <Dialog open title="استيراد تراكيب الأصناف" onClose={() => { if (!running) onClose(); }}>
      <div className="form-stack">
        <Notice>استيراد ملف JSON المجهز من عمود Excel واحد، مع تكرار اسم التركيب في حقلي الاسم العربي والإنجليزي. يُضاف الجديد فقط إلى الشركة المختارة، ولا تتغير كروت التراكيب أو الأصناف الموجودة.</Notice>
        <p><strong>الشركة التي سيُستورد إليها:</strong> {context.company.name}</p>
        <div className="field">
          <label htmlFor="composition-import-file">ملف استيراد التراكيب</label>
          <input id="composition-import-file" type="file"
            accept=".json,application/json" disabled={running}
            onChange={(event) => void readFile(event.target.files?.[0])}/>
        </div>
        {fileName && <small className="muted">الملف: {fileName}</small>}
        {payload && <div className="details-list">
          <div>عدد التراكيب في الملف: <strong>{payload.count.toLocaleString("ar-YE")}</strong></div>
          <div>تمت معالجة: <strong>{offset.toLocaleString("ar-YE")}</strong></div>
          <div>أُضيف: <strong>{created.toLocaleString("ar-YE")}</strong> — موجود مسبقًا: <strong>{skipped.toLocaleString("ar-YE")}</strong></div>
          <progress max={payload.count} value={offset} style={{width:"100%"}}/>
        </div>}
        {payload && !finished && <label className="check-label">
          <input type="checkbox" checked={confirmed} disabled={running}
            onChange={(event) => setConfirmed(event.target.checked)}/>
          أؤكد استيراد هذه التراكيب إلى شركة «{context.company.name}».
        </label>}
        {error && <Notice tone="error">{error}</Notice>}
        {notice && <Notice tone="success">{notice}</Notice>}
        <div className="form-actions">
          <Button onClick={() => void run()}
            disabled={!payload || !confirmed || finished || running}>
            {offset > 0 ? "استكمال الاستيراد" : "بدء الاستيراد"}
          </Button>
          {running && <Button variant="secondary" onClick={() => { pause.current = true; }}>
            إيقاف مؤقت بعد الدفعة الحالية
          </Button>}
          <Button variant="secondary" disabled={running} onClick={onClose}>
            {finished ? "إغلاق" : "إلغاء"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
