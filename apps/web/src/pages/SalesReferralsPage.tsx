import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CompanyContext, Page } from "../../../../packages/contracts/src/index";
import { api, useSession } from "../api";
import { errorMessage } from "../phase2";
import { Button, Card, Field, Notice, PageHeader } from "../ui";

interface Referral {
  id: number;
  companyId: number;
  kind: "doctor" | "entity";
  name: string;
  category: string | null;
  phone: string | null;
  details: string;
  archived: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
interface ReferralDraft {
  category: string;
  phone: string;
  details: string;
}
const cardLabel = (kind: Referral["kind"]) => kind === "doctor" ? "طبيب" : "جهة";

export function SalesReferralsPage({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const canEdit = context.general || context.permissions.includes("commerce.manage");
  const { user } = useSession();
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const kind = params.get("kind") || "";
  const status = params.get("status") || "pending";
  const q = params.get("q") || "";
  const page = Math.max(1, Number(params.get("page") || 1) || 1);
  const id = Number(params.get("focus") || 0);
  const selectedId = Number.isSafeInteger(id) && id > 0 ? id : null;
  const [draft, setDraft] = useState<ReferralDraft>({ category: "", phone: "", details: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  function change(key: string, value: string | null) {
    setParams(old => {
      const next = new URLSearchParams(old);
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
      if (key !== "page" && key !== "focus") next.delete("page");
      return next;
    });
  }
  const list = useQuery({
    queryKey: ["sales-referrals", user?.id, companyId, kind, status, q, page],
    enabled: !!user,
    queryFn: ({ signal }) => api<Page<Referral>>(
      `/companies/${companyId}/sales-referrals?${new URLSearchParams({
        ...(kind ? { kind } : {}),
        status,
        q,
        page: String(page),
      })}`,
      { signal },
    ),
  });
  const detail = useQuery({
    queryKey: ["sales-referral-card", user?.id, companyId, selectedId],
    enabled: !!user && selectedId !== null,
    queryFn: ({ signal }) => api<{ referral: Referral }>(
      `/companies/${companyId}/sales-referrals/${selectedId}`,
      { signal },
    ),
  });
  const referral = detail.data?.referral ?? null;
  useEffect(() => {
    if (!referral) return;
    setDraft({
      category: referral.category ?? "",
      phone: referral.phone ?? "",
      details: referral.details,
    });
    setError("");
    setSuccess("");
  }, [referral?.id, referral?.revision]);

  async function save(archived: boolean) {
    if (!referral || !canEdit || saving) return;
    setError("");
    setSuccess("");
    setSaving(true);
    try {
      const response = await api<{ referral: Referral }>(
        `/companies/${companyId}/sales-referrals/${referral.id}`,
        {
          method: "PATCH",
          body: {
            revision: referral.revision,
            category: draft.category.trim() || null,
            phone: draft.phone.trim() || null,
            details: draft.details.trim(),
            archived,
          },
        },
      );
      await client.invalidateQueries({ queryKey: ["sales-referrals", user?.id, companyId] });
      await client.invalidateQueries({ queryKey: ["sales-referral-card", user?.id, companyId, referral.id] });
      await client.invalidateQueries({ queryKey: ["notifications", user?.id] });
      setSuccess(response.referral.archived ? "تمت أرشفة الكرت." : "تم حفظ الكرت والتصنيف.");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="content-stack">
      <PageHeader
        title="كروت الأطباء والجهات"
        description="الأسماء الجديدة من فواتير المبيعات تُسجل تلقائيًا دون فئة. راجعها وأكمل البيانات أو أرشفها."
      />
      <Card>
        <div className="form-grid">
          <Field
            label="بحث في الاسم"
            value={q}
            onChange={event => change("q", event.target.value)}
          />
          <label className="field">
            <span>النوع</span>
            <select value={kind} onChange={event => change("kind", event.target.value)}>
              <option value="">الكل</option>
              <option value="doctor">الأطباء</option>
              <option value="entity">الجهات</option>
            </select>
          </label>
          <label className="field">
            <span>الحالة</span>
            <select value={status} onChange={event => change("status", event.target.value)}>
              <option value="pending">تحتاج تصنيفًا</option>
              <option value="all">كل الكروت</option>
              <option value="archived">المؤرشفة</option>
            </select>
          </label>
        </div>
        {list.isPending && <Notice>جارٍ تحميل الكروت…</Notice>}
        {list.error && <Notice tone="error">{errorMessage(list.error)}</Notice>}
        {list.data && (
          <>
            <p>عدد النتائج: {list.data.total}</p>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr><th>النوع</th><th>الاسم</th><th>الفئة</th><th>الحالة</th><th>إجراءات</th></tr>
                </thead>
                <tbody>
                  {list.data.items.map(row => (
                    <tr key={row.id}>
                      <td>{cardLabel(row.kind)}</td>
                      <td>{row.name}</td>
                      <td>{row.category || "بدون فئة"}</td>
                      <td>{row.archived ? "مؤرشف" : row.category ? "مكتمل التصنيف" : "يحتاج مراجعة"}</td>
                      <td><Button variant="secondary" onClick={() => change("focus", String(row.id))}>فتح الكرت</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {list.data.items.length === 0 && <Notice>لا توجد كروت مطابقة.</Notice>}
            <div className="form-actions">
              <Button variant="secondary" disabled={page <= 1} onClick={() => change("page", String(page - 1))}>السابق</Button>
              <span>صفحة {page}</span>
              <Button variant="secondary" disabled={page * 100 >= list.data.total} onClick={() => change("page", String(page + 1))}>التالي</Button>
            </div>
          </>
        )}
      </Card>
      {selectedId !== null && (
        <Card>
          {detail.isPending && <Notice>جارٍ فتح الكرت…</Notice>}
          {detail.error && <Notice tone="error">{errorMessage(detail.error)}</Notice>}
          {referral && (
            <>
              <div className="form-actions">
                <strong>كرت {cardLabel(referral.kind)}: {referral.name}</strong>
                <Button variant="ghost" onClick={() => change("focus", null)}>إغلاق الكرت</Button>
              </div>
              <p>{referral.archived ? "مؤرشف" : referral.category ? "مصنف" : "بحاجة إلى تحديد الفئة"}</p>
              <Field label="الفئة" disabled={!canEdit || saving} value={draft.category}
                onChange={event => setDraft(old => ({ ...old, category: event.target.value }))} maxLength={100} />
              <Field label="رقم الهاتف" disabled={!canEdit || saving} value={draft.phone}
                onChange={event => setDraft(old => ({ ...old, phone: event.target.value }))} maxLength={50} />
              <Field label="باقي التفاصيل" disabled={!canEdit || saving} value={draft.details}
                onChange={event => setDraft(old => ({ ...old, details: event.target.value }))} maxLength={2000} />
              {error && <Notice tone="error">{error}</Notice>}
              {success && <Notice>{success}</Notice>}
              <div className="form-actions">
                <Link className="button button-secondary" to={`/companies/${companyId}/sales?${referral.kind === "doctor" ? "doctorReferralId" : "entityReferralId"}=${referral.id}`}>عرض الحركات المرتبطة</Link>
                {canEdit && (
                  <>
                    <Button disabled={saving} onClick={() => void save(referral.archived)}>حفظ بيانات الكرت</Button>
                    <Button variant="secondary" disabled={saving}
                      onClick={() => void save(!referral.archived)}>
                      {referral.archived ? "إلغاء الأرشفة" : "أرشفة الكرت"}
                    </Button>
                  </>
                )}
              </div>
            </>
          )}
        </Card>
      )}
    </div>
  );
}
