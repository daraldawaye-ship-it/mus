import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, useSession } from "../api";
import { errorMessage } from "../phase2";
import { Button, Card, Field, Notice, PageHeader } from "../ui";

type Item = { id: string; title: string; notes: string };
type Draft = { revision: number; classifications: Item[] };
const path = "/owner/medicine-taxonomy";
const blank = (): Item => ({ id: crypto.randomUUID(), title: "", notes: "" });

export default function MarketMedicineTaxonomyPage() {
  const { user } = useSession(), cache = useQueryClient();
  const key = ["owner-medicine-taxonomy", user?.id] as const;
  const query = useQuery({ queryKey: key, queryFn: ({ signal }) => api<Draft>(path, { signal }) });
  const [edits, setEdits] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const draft = edits ?? query.data;
  function change(classifications: Item[]) {
    if (!draft) return;
    setEdits({ ...draft, classifications });
    setSaved(false);
  }
  function update(position: number, item: Item) {
    if (!draft) return;
    change(draft.classifications.map((row, index) => index === position ? item : row));
  }
  async function save() {
    if (!edits || saving || !navigator.onLine) return;
    setSaving(true);
    setError("");
    try {
      const result = await api<Draft>(path, { method: "PUT", body: { expectedRevision: edits.revision, classifications: edits.classifications } });
      cache.setQueryData(key, result);
      setEdits(null);
      setSaved(true);
    } catch (problem) {
      setError(errorMessage(problem));
    } finally {
      setSaving(false);
    }
  }

  const classifications = draft?.classifications ?? [];
  return <section dir="rtl">
    <PageHeader title="التصنيف الدوائي" actions={<Link to="/medicine-market">العودة إلى السوق</Link>} />
    <Card>
      <Notice>مسودة إدارية للمالك. كل تصنيف سجل مستقل، ولا تظهر التصنيفات للزوار ولا تُربط بالتراكيب قبل اعتمادها.</Notice>
      {query.isError && !draft ? <Notice tone="error">تعذر تحميل المسودة. <Button type="button" onClick={() => void query.refetch()}>حاول مجددًا</Button></Notice>
        : !draft ? <Notice>جارٍ تحميل المسودة…</Notice> : <form onSubmit={event => { event.preventDefault(); void save(); }}>
        {!classifications.length && <p>لا توجد تصنيفات محفوظة بعد.</p>}
        <fieldset disabled={saving} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          {classifications.map((item, index) => <fieldset key={item.id} style={{ margin: "12px 0", minWidth: 0 }}>
            <legend>تصنيف {index + 1}</legend>
            <Field label="اسم التصنيف" value={item.title} maxLength={100} required onChange={e => update(index, { ...item, title: e.target.value })} />
            <label className="field">ملاحظات إدارية (اختياري)
              <textarea value={item.notes} maxLength={500} onChange={e => update(index, { ...item, notes: e.target.value })} />
            </label>
          </fieldset>)}
          <div className="page-actions">
            <Button type="button" variant="secondary" disabled={classifications.length >= 60} onClick={() => change([...classifications, blank()])}>إضافة تصنيف</Button>
            <Button type="submit" disabled={!edits}>{saving ? "جارٍ الحفظ…" : "حفظ المسودة"}</Button>
            {edits && <Button type="button" variant="secondary" onClick={() => { setEdits(null); setError(""); void query.refetch(); }}>إلغاء تعديلات غير محفوظة</Button>}
          </div>
        </fieldset>
        {!navigator.onLine && <Notice>يتطلب حفظ المسودة الاتصال بالإنترنت.</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
        {saved && <Notice tone="success">حُفظت المسودة الإدارية.</Notice>}
      </form>}
    </Card>
  </section>;
}
