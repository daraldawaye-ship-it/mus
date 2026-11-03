import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CompanyContext } from "../../../../packages/contracts/src/index";
import { api, useSession } from "../api";
import { usePageDirectory } from "../page-directory";
import { Button, Card, Field, Notice, PageHeader } from "../ui";

type DeviceCategory = "unclassified" | "pharmacy" | "employee";
type DeviceRow = {
  id: string;
  name: string;
  category: DeviceCategory;
  approved: boolean;
  deviceKind: "desktop_browser" | "mobile_browser" | "android_app" | "iphone_app";
  browser: string;
  operatingSystem: string;
  revision: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastUserId: number | null;
  lastUserName: string | null;
  userCount: number;
};
type DevicePage = {
  items: DeviceRow[];
  total: number;
  page: number;
  pageSize: number;
};

const categoryNames: Record<DeviceCategory, string> = {
  unclassified: "غير مصنف",
  pharmacy: "جهاز الصيدلية",
  employee: "جهاز موظف",
};
const kindNames: Record<DeviceRow["deviceKind"], string> = {
  desktop_browser: "متصفح كمبيوتر",
  mobile_browser: "متصفح هاتف",
  android_app: "تطبيق أندرويد",
  iphone_app: "تطبيق آيفون / آيباد",
};
function dateTime(value: string) {
  return new Intl.DateTimeFormat("ar", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
function message(error: unknown) {
  return error instanceof Error ? error.message : "تعذر تنفيذ الطلب";
}

export function CompanyApprovedDevicesPage({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const { user } = useSession();
  const queryClient = useQueryClient();
  const directory = usePageDirectory(companyId);
  const canEdit = !!directory.data?.find((entry) => entry.key === "company.approved-devices")?.actionAccess.edit;
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [category, setCategory] = useState<DeviceCategory>("unclassified");
  const [approved, setApproved] = useState(false);
  const [revision, setRevision] = useState(1);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const devices = useQuery({
    queryKey: ["approved-devices", user?.id, companyId, page, search],
    queryFn: ({ signal }) => api<DevicePage>(
      "/companies/" + companyId + "/approved-devices?" +
      new URLSearchParams({ page: String(page), pageSize: "30", q: search }).toString(),
      { signal },
    ),
    enabled: !!user,
    staleTime: 10_000,
    refetchInterval: 5 * 60_000,
  });

  function startEdit(item: DeviceRow) {
    setEditingId(item.id);
    setName(item.name);
    setCategory(item.category);
    setApproved(item.approved);
    setRevision(item.revision);
    setError("");
    setNotice("");
  }
  async function save() {
    if (!editingId || saving || !canEdit) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await api("/companies/" + companyId + "/approved-devices/" + editingId, {
        method: "PATCH",
        body: { name: name.trim(), category, approved, revision },
      });
      await queryClient.invalidateQueries({ queryKey: ["approved-devices", user?.id, companyId] });
      setEditingId(null);
      setNotice("تم حفظ بيانات الجهاز. لم تتغير أي صلاحيات للدخول أو للصفحات.");
    } catch (reason) {
      setError(message(reason));
    } finally {
      setSaving(false);
    }
  }
  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearch(searchText.trim());
    setPage(1);
    setEditingId(null);
  }

  return (
    <>
      <PageHeader
        title="الأجهزة المعتمدة"
        description="سجل أجهزة الصيدلية والموظفين التي استُخدم منها الموقع داخل هذه الشركة."
        actions={<Button variant="secondary" onClick={() => void devices.refetch()}>تحديث القائمة</Button>}
      />
      <Notice>
        يسجل الموقع المتصفح أو التطبيق تلقائيًا عند الدخول للشركة أثناء الاتصال بالإنترنت.
        يمكنك تسمية الجهاز وتصنيفه واعتماده للتوثيق فقط؛ لا تُفرض صلاحيات أو قيود دخول على الأجهزة في هذه المرحلة.
      </Notice>
      <Card>
        <form onSubmit={submitSearch} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" }}>
          <div style={{ flex: "1 1 220px" }}>
            <Field label="بحث باسم الجهاز أو المتصفح أو آخر مستخدم" value={searchText}
              onChange={(event) => setSearchText(event.target.value)} maxLength={80} />
          </div>
          <Button type="submit">بحث</Button>
          {search && <Button variant="ghost" onClick={() => { setSearchText(""); setSearch(""); setPage(1); }}>إلغاء البحث</Button>}
        </form>
        <p className="muted">عدد الأجهزة المطابقة: {devices.data?.total ?? "—"}</p>
      </Card>
      {notice && <Notice tone="success">{notice}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {devices.isError && <Notice tone="error">{message(devices.error)} <Button variant="ghost" onClick={() => void devices.refetch()}>إعادة المحاولة</Button></Notice>}
      {devices.isPending && <Notice>جارٍ تحميل الأجهزة المسجلة…</Notice>}
      {devices.data?.items.length === 0 && <Notice>لا توجد أجهزة مسجلة حتى الآن. ستظهر الأجهزة عند فتح الشركة من أجهزتها أثناء الاتصال.</Notice>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))", gap: 12 }}>
        {devices.data?.items.map((item) => (
          <Card key={item.id} title={item.name || "جهاز غير مسمى"} description={categoryNames[item.category]}>
            <div style={{ display: "grid", gap: 5 }}>
              <span><strong>حالة التوثيق:</strong> {item.approved ? "معتمد" : "بانتظار التوثيق"}</span>
              <span><strong>نوع الوصول:</strong> {kindNames[item.deviceKind]}</span>
              <span><strong>النظام والمتصفح:</strong> {item.operatingSystem} — {item.browser}</span>
              <span><strong>آخر مستخدم:</strong> {item.lastUserName ?? "غير معروف"}</span>
              <span><strong>عدد الحسابات التي استخدمته:</strong> {item.userCount}</span>
              <span><strong>أول ظهور:</strong> {dateTime(item.firstSeenAt)}</span>
              <span><strong>آخر ظهور:</strong> {dateTime(item.lastSeenAt)}</span>
            </div>
            {canEdit && editingId !== item.id && (
              <div style={{ marginTop: 10 }}>
                <Button variant="secondary" onClick={() => startEdit(item)}>تسمية وتصنيف الجهاز</Button>
              </div>
            )}
            {canEdit && editingId === item.id && (
              <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
                <Field label="اسم الجهاز" value={name} onChange={(event) => setName(event.target.value)} maxLength={80}
                  placeholder="مثلاً: كاشير الصيدلية 1" />
                <label>تصنيف الجهاز
                  <select value={category} onChange={(event) => setCategory(event.target.value as DeviceCategory)}>
                    {Object.entries(categoryNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                  </select>
                </label>
                <label className="check-label">
                  <input type="checkbox" checked={approved} onChange={(event) => setApproved(event.target.checked)} />
                  جهاز معتمد للتوثيق (لا يؤثر على الصلاحيات)
                </label>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <Button disabled={saving} onClick={() => void save()}>{saving ? "جارٍ الحفظ…" : "حفظ"}</Button>
                  <Button variant="ghost" disabled={saving} onClick={() => setEditingId(null)}>إلغاء</Button>
                </div>
              </div>
            )}
          </Card>
        ))}
      </div>
      {!!devices.data && devices.data.total > devices.data.pageSize && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, marginTop: 12 }}>
          <Button variant="secondary" disabled={page <= 1} onClick={() => { setPage(page - 1); setEditingId(null); }}>السابق</Button>
          <span>صفحة {page} من {Math.ceil(devices.data.total / devices.data.pageSize)}</span>
          <Button variant="secondary" disabled={page * devices.data.pageSize >= devices.data.total} onClick={() => { setPage(page + 1); setEditingId(null); }}>التالي</Button>
        </div>
      )}
    </>
  );
}
