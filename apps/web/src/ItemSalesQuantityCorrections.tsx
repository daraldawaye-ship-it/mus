import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { normalizeDigits } from "../../../packages/contracts/src/index";
import { api, ApiFailure, useSession } from "./api";
import { errorMessage } from "./phase2";
import { Button, Notice } from "./ui";

type SalesQuantityRow = {
  sourceKey: string;
  sourceKind: "posted" | "staged";
  documentDate: string;
  invoiceNumber: string | null;
  lineNumber: number;
  originalQuantity: string | null;
  originalRecordedQuantity: string | null;
  originalRecordedUnit: string | null;
  correctedQuantity: string | null;
  revision: number;
  reason: string | null;
  unitName: string;
  canCorrect: boolean;
};
type SalesQuantityPage = { items: SalesQuantityRow[]; page: number; pageSize: number; hasMore: boolean };
type Draft = { row: SalesQuantityRow; amount: string; reason: string };

export function ItemSalesQuantityCorrections({ companyId, itemId }: { companyId: number; itemId: number }) {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const prefix = ["items", user?.id, companyId, "sales-quantity-corrections", itemId] as const;
  const endpoint = `/companies/${companyId}/item-history/${itemId}/sales-quantity-corrections`;
  const result = useQuery({
    queryKey: [...prefix, page],
    queryFn: ({ signal }) => api<SalesQuantityPage>(`${endpoint}?page=${page}&pageSize=20`, { signal }),
    enabled: open && !!user,
    retry: false,
  });

  async function save(reset = false) {
    if (!user?.owner || !draft?.row.canCorrect || saving) return;
    const reason = draft.reason.trim();
    if (!reason) {
      setFeedback({ error: true, text: "اكتب سبب التصحيح أو الإلغاء." });
      return;
    }
    const raw = normalizeDigits(draft.amount.trim()).replace(/^−/, "-");
    if (!reset && !/^[+-]?\d+(?:\.\d+)?$/.test(raw)) {
      setFeedback({ error: true, text: "أدخل كمية رقمية: موجبة للبيع، سالبة للمرتجع، أو صفرًا." });
      return;
    }
    const correctedQuantity = reset ? null : raw.replace(/^\+/, "");
    setSaving(true);
    setFeedback(null);
    try {
      const { item } = await api<{ item: SalesQuantityRow }>(endpoint, { method: "PATCH", body: {
        sourceKey: draft.row.sourceKey, correctedQuantity, reason, expectedRevision: draft.row.revision,
      } });
      queryClient.setQueryData<SalesQuantityPage>([...prefix, page], current => current && ({
        ...current, items: current.items.map(row => row.sourceKey === item.sourceKey ? item : row),
      }));
      setDraft(null);
      setFeedback({ error: false, text: reset ? "أُلغي التصحيح وعاد الاحتساب إلى الكمية الأصلية." : "حُفظت كمية المبيعات المصححة." });
      void queryClient.invalidateQueries({ queryKey: prefix });
      void queryClient.invalidateQueries({ queryKey: ["items", user.id, companyId, "activity", itemId] });
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 409) {
        setDraft(null);
        void result.refetch();
        setFeedback({ error: true, text: "تغيّر السطر منذ فتحه. راجع بياناته الحالية ثم افتح التصحيح من جديد." });
      } else {
        setFeedback({ error: true, text: errorMessage(error) });
      }
    } finally { setSaving(false); }
  }

  return (
    <section aria-label="المبيعات: تصحيح الكمية">
      <div className="form-actions">
        <Button type="button" size="compact" variant="secondary" aria-expanded={open} disabled={saving}
          onClick={() => { setOpen(!open); setDraft(null); setFeedback(null); }}>
          {open ? "إخفاء سطور المبيعات" : "المبيعات: عرض السطور وتصحيح الكمية"}
        </Button>
      </div>
      {open && <>
        <p>للاحتساب فقط. الموجب بيع والسالب مرتجع، والصفر كمية صحيحة. لا تتغير الفاتورة أو المخزون أو الحسابات أو عدد مرات البيع.</p>
        {feedback && <Notice tone={feedback.error ? "error" : "success"}>{feedback.text}</Notice>}
        {result.isPending && <Notice>جارٍ تحميل سطور المبيعات…</Notice>}
        {result.error && <Notice tone="error">{errorMessage(result.error)}</Notice>}
        {result.data?.items.length === 0 && <Notice>لا توجد سطور مبيعات لهذا الصنف.</Notice>}
        {result.data?.items.map(row => (
          <div className="user-menu-item-history-row" key={row.sourceKey}>
            <div className="user-menu-item-history-meta">
              <strong>{row.sourceKind === "posted" ? "مرحّل" : "مستورد غير مرحّل"}</strong>
              <bdi dir="ltr">{row.documentDate}</bdi>
              {row.invoiceNumber && <span>فاتورة <bdi>{row.invoiceNumber}</bdi></span>}
              <span>السطر <bdi>{row.lineNumber}</bdi></span>
            </div>
            <div className="user-menu-item-history-meta">
              <span>الأصلية: {row.originalQuantity !== null
                ? <><bdi dir="ltr">{row.originalQuantity}</bdi> {row.unitName}</>
                : row.originalRecordedQuantity !== null
                  ? <><bdi dir="ltr">{row.originalRecordedQuantity}</bdi> {row.originalRecordedUnit} (كما استوردت؛ التحويل للوحدة الأولى غير مؤكد)</>
                  : "غير متاحة"}</span>
              <span>المصححة: {row.correctedQuantity === null ? "لا يوجد" : <><bdi dir="ltr">{row.correctedQuantity}</bdi> {row.unitName}</>}</span>
              {row.reason && <span>السبب: {row.reason}</span>}
            </div>
            {draft?.row.sourceKey === row.sourceKey ? (
              <>
                <label>الكمية المصححة <input type="text" dir="ltr" value={draft.amount} disabled={saving}
                  onChange={event => setDraft({ ...draft, amount: event.target.value })} /></label>
                <label>سبب التعديل <input type="text" value={draft.reason} maxLength={500} disabled={saving}
                  onChange={event => setDraft({ ...draft, reason: event.target.value })} /></label>
                <div className="form-actions">
                  <Button type="button" size="compact" disabled={saving} onClick={() => void save()}>حفظ التصحيح</Button>
                  {draft.row.correctedQuantity !== null &&
                    <Button type="button" size="compact" variant="secondary" disabled={saving}
                      onClick={() => void save(true)}>الرجوع للكمية الأصلية</Button>}
                  <Button type="button" size="compact" variant="ghost" disabled={saving}
                    onClick={() => { setDraft(null); setFeedback(null); }}>إلغاء</Button>
                </div>
              </>
            ) : user?.owner && row.canCorrect && row.originalQuantity !== null &&
              <Button type="button" size="compact" variant="ghost" disabled={saving}
                onClick={() => { setDraft({ row, amount: row.correctedQuantity ?? row.originalQuantity ?? "", reason: "" }); setFeedback(null); }}>
                تصحيح كمية السطر
              </Button>}
          </div>
        ))}
        {result.data && (page > 1 || result.data.hasMore) && <div className="form-actions">
          <Button type="button" size="compact" variant="ghost" disabled={page <= 1 || saving || !!draft}
            onClick={() => setPage(page - 1)}>السابق</Button>
          <span>صفحة <bdi>{page}</bdi></span>
          <Button type="button" size="compact" variant="ghost" disabled={!result.data.hasMore || saving || !!draft}
            onClick={() => setPage(page + 1)}>التالي</Button>
        </div>}
      </>}
    </section>
  );
}
