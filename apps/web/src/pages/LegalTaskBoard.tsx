import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, useScopeGuard, useSession } from "../api";
import { Button, Card, Field, Notice, Select } from "../ui";
import { errorMessage } from "../phase2";

export type LegalTaskPriority = {
  id: number;
  revision: number;
  task_priority: number | null;
  task_priority_reason: string;
  priority: number;
  reason: string;
  source: "manual" | "automatic";
};
type Task = LegalTaskPriority & {
  title: string;
  body: string;
  status: string;
  due_at: string | null;
  cases: { id: number; title: string; next_hearing: string | null }[];
};
const labels: Record<string, string> = {
  pending: "مطلوبة", working: "جارٍ العمل", submitted: "تم الإبلاغ",
  blocked: "متعذرة", verified: "منجزة",
};

export function LegalTaskPriorityControl({ task }: { task: LegalTaskPriority }) {
  const cache = useQueryClient();
  const guard = useScopeGuard(`legal:task-priority:${task.id}`);
  const [edit, setEdit] = useState(false);
  const [priority, setPriority] = useState("auto");
  const [reason, setReason] = useState("");
  const [revision, setRevision] = useState(task.revision);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  async function save() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api(`/legal/tasks/${task.id}/priority`, {
        method: "PUT",
        body: { priority: priority === "auto" ? null : Number(priority), reason, revision },
        signal: guard.signal,
      });
      if (!guard.isCurrent()) return;
      setEdit(false);
      setSaved(true);
      await cache.invalidateQueries({ queryKey: ["legal"] });
    } catch (cause) {
      if (guard.isCurrent()) {
        setError(errorMessage(cause));
        void cache.invalidateQueries({ queryKey: ["legal"] });
      }
    } finally {
      if (guard.isCurrent()) setBusy(false);
    }
  }
  return <div className="legal-priority-control">
    {edit ? <div className="legal-priority-edit">
      <Select label="الأولوية" value={priority} disabled={busy}
        onChange={event => setPriority(event.target.value)}>
        <option value="auto">تلقائية حسب المعطيات</option>
        {Array.from({ length: 10 }, (_, i) => <option key={i} value={String(i + 1)}>
          {i + 1}{i === 0 ? " — الأكثر استعجالًا" : ""}
        </option>)}
      </Select>
      <Field label="سبب الأولوية" value={reason} maxLength={2000} disabled={busy || priority === "auto"}
        onChange={event => setReason(event.target.value)} />
      <div className="legal-actions">
        <Button disabled={busy} onClick={() => void save()}>{busy ? "جارٍ الحفظ…" : "حفظ الأولوية"}</Button>
        <Button variant="secondary" disabled={busy} onClick={() => { setEdit(false); setError(""); }}>إلغاء</Button>
      </div>
    </div> : <Button size="compact" variant="secondary" disabled={busy} onClick={() => {
      setPriority(task.task_priority === null ? "auto" : String(task.task_priority));
      setReason(task.task_priority_reason);
      setRevision(task.revision);
      setError("");
      setSaved(false);
      setEdit(true);
    }}>تغيير الأولوية</Button>}
    {error && <Notice tone="error">{error}</Notice>}
    {saved && <span role="status">حُفظت الأولوية وأُعيد ترتيب المهام.</span>}
  </div>;
}

export function LegalTaskBoard({ owner, onOpenCase }: { owner: boolean; onOpenCase: (caseId: number) => void }) {
  const { user } = useSession();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("open");
  const query = useQuery({
    queryKey: ["legal", "task-board", user?.id],
    queryFn: ({ signal }) => api<{ items: Task[]; total: number }>("/legal/tasks", { signal }),
    enabled: !!user,
    refetchInterval: 60_000,
  });
  const tasks = useMemo(() => (query.error ? [] : query.data?.items ?? []).filter(task =>
    (filter === "all" || (filter === "open" && task.status !== "verified") ||
      (filter === "done" && task.status === "verified") || filter === String(task.priority)) &&
    (!search || [task.title, task.body, ...task.cases.map(c => c.title)].join(" ").includes(search)),
  ), [query.data, query.error, filter, search]);
  return <Card title="جميع المهام — حسب الأولوية">
    <p>تظهر المهام غير المنجزة أولًا، والأولوية 1 هي الأكثر استعجالًا. تُقيّم الأولوية تلقائيًا من المواعيد والمعطيات المسجلة. يمكنك تحديد أولوية لمهمة واحدة أو إعادتها إلى التقييم التلقائي.</p>
    <div className="legal-actions">
      <Field label="بحث في المهام" value={search} onChange={event => setSearch(event.target.value)} />
      <Select label="تصفية المهام" value={filter} onChange={event => setFilter(event.target.value)}>
        <option value="open">غير المنجزة</option><option value="all">الكل</option><option value="done">المنجزة</option>
        {Array.from({ length: 10 }, (_, i) => <option key={i} value={String(i + 1)}>أولوية {i + 1}</option>)}
      </Select>
    </div>
    {query.isPending && <Notice>جارٍ تحميل المهام…</Notice>}
    {query.error && <Notice tone="error">{errorMessage(query.error)} <Button variant="secondary" onClick={() => void query.refetch()}>إعادة المحاولة</Button></Notice>}
    {query.data && !query.error && <p>عدد المعروض: {tasks.length} / {query.data.total}</p>}
    {!query.isPending && !query.error && !tasks.length && <Notice>لا توجد مهام مطابقة.</Notice>}
    <div className="legal-task-scroll"><table className="legal-task-table" aria-label="المهام حسب الأولوية">
      <thead><tr><th scope="col">#</th><th scope="col">الأولوية</th><th scope="col">المهمة</th><th scope="col">القضية</th><th scope="col">الموعد</th><th scope="col">الحالة</th>{owner && <th scope="col">تعديل</th>}</tr></thead>
      <tbody>{tasks.map((task, index) => <tr key={task.id}>
        <td>{index + 1}</td><td><strong>{task.priority}</strong><small>{task.source === "manual" ? "يدوي" : "تلقائي"}</small><small>{task.reason}</small></td>
        <td><strong>{task.title}</strong><details><summary>التفاصيل</summary><p className="legal-preserve">{task.body}</p></details></td>
        <td>{task.cases.length ? task.cases.map(c => <Button key={c.id} size="compact" variant="secondary"
          onClick={() => onOpenCase(c.id)}>{c.title}</Button>) : "غير مرتبطة"}</td>
        <td>{task.due_at ? new Date(task.due_at).toLocaleDateString("ar-YE", { timeZone: "Asia/Aden" }) : "غير محدد"}</td>
        <td>{labels[task.status] ?? task.status}</td>
        {owner && <td><LegalTaskPriorityControl task={task} /></td>}
      </tr>)}</tbody>
    </table></div>
  </Card>;
}
