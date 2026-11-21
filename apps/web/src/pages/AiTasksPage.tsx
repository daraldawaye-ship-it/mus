import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { api } from "../api";
import { errorMessage } from "../phase2";
import { Button, DataTable, Dialog, Field, Notice, PageHeader } from "../ui";

const sections = ["السوق العام", "الشركة", "القضايا", "إدارة الموقع", "مهمة خاصة بمصطفى"];
const formatter = new Intl.DateTimeFormat("ar", {
  dateStyle: "short", timeStyle: "short", timeZone: "Asia/Aden",
});
const formatDate = (value: string | null) => value ? formatter.format(new Date(value)) : "—";

type Company = { id: number; name: string };
type Task = {
  id: number;
  title: string;
  description: string;
  section: string;
  companyId: number | null;
  companyName: string | null;
  cadenceHours: number | null;
  cadenceLabel: string | null;
  archived: boolean;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  latestRunInProgress: boolean;
  lastResult: string;
  resumeFrom: string | null;
  nextEligibleAt: string | null;
};

type Run = {
  id: number;
  title: string;
  detail: string;
  startedAt: string | null;
  finishedAt: string | null;
  recordedAt: string;
  resumeFrom: string | null;
};

const sectionLabel = (task: Task) => task.companyName ? `${task.section} · ${task.companyName}` : task.section;

export function AiTasksPage() {
  const queryClient = useQueryClient();
  const [archived, setArchived] = useState(false);
  const [section, setSection] = useState("");
  const [company, setCompany] = useState("");
  const [search, setSearch] = useState("");
  const [sorting, setSorting] = useState<SortingState>([{ id: "lastStartedAt", desc: true }]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [showNew, setShowNew] = useState(false);
  const [details, setDetails] = useState<Task | null>(null);
  const [historyTask, setHistoryTask] = useState<Task | null>(null);
  const [archiveTask, setArchiveTask] = useState<Task | null>(null);
  const query = useQuery({
    queryKey: ["owner-ai-tasks"],
    queryFn: ({ signal }) => api<{ tasks: Task[]; companies: Company[] }>("/ai-tasks", { signal }),
  });
  const archiveMutation = useMutation({
    mutationFn: (task: Task) => api(`/ai-tasks/${task.id}/archive`, {
      method: "PATCH", body: { archived: !task.archived },
    }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["owner-ai-tasks"] });
      setArchiveTask(null);
    },
  });
  const history = useQuery({
    queryKey: ["owner-ai-tasks", "history", historyTask?.id],
    queryFn: ({ signal }) => api<{ history: Run[] }>(`/ai-tasks/${historyTask!.id}/history`, { signal }),
    enabled: historyTask !== null,
  });
  const tasks = query.data?.tasks ?? [];
  const companies = query.data?.companies ?? [];
  const availableSections = Array.from(new Set([...sections, ...tasks.map(task => task.section)]));
  const term = search.trim().toLocaleLowerCase("ar");
  const visible = tasks.filter(task => task.archived === archived &&
    (!section || task.section === section) && (!company || task.companyId === Number(company)) &&
    (!term || [task.title, sectionLabel(task), task.description].some(value => value.toLocaleLowerCase("ar").includes(term))));
  const columns: ColumnDef<Task, unknown>[] = [
    { accessorKey: "title", header: "المهمة" },
    { id: "section", accessorFn: sectionLabel, header: "القسم" },
    { accessorKey: "description", header: "الشرح والآلية", cell: ({ row }) =>
      <Button type="button" onClick={() => setDetails(row.original)}>عرض</Button> },
    { id: "lastStartedAt", accessorFn: task => task.lastStartedAt ? Date.parse(task.lastStartedAt) : null,
      header: "آخر بدء", cell: ({ row }) => {
        const task = row.original;
        return <span title={task.latestRunInProgress ? "الجولة الأخيرة قيد التنفيذ" : "وقت بدء آخر جولة"}>
          {formatDate(task.lastStartedAt)}{task.latestRunInProgress && " · جارٍ"}
        </span>;
      } },
    { id: "lastFinishedAt", accessorFn: task => task.lastFinishedAt ? Date.parse(task.lastFinishedAt) : null,
      header: "آخر انتهاء", cell: ({ row }) => {
        const task = row.original;
        return <span title={task.latestRunInProgress
          ? "وقت انتهاء آخر جولة مكتملة؛ الجولة الحالية لم تنتهِ بعد" : "وقت انتهاء آخر جولة مكتملة"}>
          {formatDate(task.lastFinishedAt)}{task.latestRunInProgress && task.lastFinishedAt && " · سابقة"}
        </span>;
      } },
    { id: "cadenceHours", accessorFn: task => task.cadenceHours ?? task.cadenceLabel, header: "تُنجز كل", cell: ({ row }) => {
      const task = row.original;
      return <span title={task.nextEligibleAt ? `الاستحقاق التالي ${formatDate(task.nextEligibleAt)}` : undefined}>
        {task.cadenceHours === null ? task.cadenceLabel ?? "غير محددة" : `${task.cadenceHours} ساعة`}
      </span>;
    } },
    { accessorKey: "lastResult", header: "بيان آخر إنجاز", cell: ({ row }) =>
      <button type="button" className="table-value" onClick={() => setHistoryTask(row.original)}
        title="فتح سجل الإنجاز">
        <span className="truncate">{row.original.lastResult || "فتح سجل الإنجاز"}</span>
      </button> },
    { id: "archiveTask", header: "أرشفة المهمة", enableSorting: false, cell: ({ row }) =>
      <Button type="button" onClick={() => { archiveMutation.reset(); setArchiveTask(row.original); }}>
        {row.original.archived ? "استرجاع" : "أرشفة"}
      </Button> },
  ];
  const ordered = visible.slice().sort((a, b) => {
    for (const sort of sorting) {
      const accessor = columns.find(column => ("id" in column && column.id === sort.id) ||
        ("accessorKey" in column && column.accessorKey === sort.id));
      const value = (task: Task) => accessor && "accessorFn" in accessor
        ? accessor.accessorFn(task, 0) : task[sort.id as keyof Task];
      const left = value(a), right = value(b);
      if (left == null || right == null) {
        if (left !== right) return left == null ? 1 : -1;
        continue;
      }
      const order = typeof left === "number" && typeof right === "number"
        ? left - right : String(left).localeCompare(String(right), "ar", { numeric: true });
      if (order) return sort.desc ? -order : order;
    }
    return b.id - a.id;
  });
  const currentPage = Math.min(page, Math.max(1, Math.ceil(ordered.length / pageSize)));

  return <>
    <PageHeader title="مهام الذكاء الاصطناعي" actions={<Button type="button" onClick={() => setShowNew(true)}>إضافة مهمة</Button>} />
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: ".5rem", marginBottom: ".5rem" }}>
      <Button type="button" aria-pressed={!archived} onClick={() => { setArchived(false); setPage(1); }}>المهام الحالية</Button>
      <Button type="button" aria-pressed={archived} onClick={() => { setArchived(true); setPage(1); }}>المؤرشفة</Button>
      <input type="search" aria-label="بحث عن مهمة" placeholder="بحث عن مهمة" value={search}
        onChange={event => { setSearch(event.target.value); setPage(1); }} />
      <select aria-label="تصفية حسب القسم" value={section}
        onChange={event => { setSection(event.target.value); setCompany(""); setPage(1); }}>
        <option value="">كل الأقسام</option>
        {availableSections.map(name => <option key={name}>{name}</option>)}
      </select>
      {section === "الشركة" && <select aria-label="تصفية حسب الشركة" value={company}
        onChange={event => { setCompany(event.target.value); setPage(1); }}>
        <option value="">كل الشركات</option>
        {companies.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>}
    </div>
    {query.error && <Notice tone="error">{errorMessage(query.error)}</Notice>}
    <DataTable columns={columns} data={ordered.slice((currentPage - 1) * pageSize, currentPage * pageSize)}
      total={ordered.length} page={currentPage} pageSize={pageSize} loading={query.isPending}
      onPageChange={setPage} onPageSizeChange={size => { setPageSize(size); setPage(1); }}
      sorting={sorting} onSortingChange={update => { setSorting(update); setPage(1); }}
      selectionMode="none" ariaLabel="مهام الذكاء الاصطناعي" />
    {showNew && <NewTaskDialog availableSections={availableSections} companies={companies} onClose={() => setShowNew(false)} />}
    {details && <Dialog open title={details.title} onClose={() => setDetails(null)}>
      <p className="full-value">{details.description || "—"}</p>
    </Dialog>}
    {historyTask && <Dialog open title={`سجل إنجاز · ${historyTask.title}`} onClose={() => setHistoryTask(null)}>
      {history.isPending && <Notice>جارٍ تحميل الجولات…</Notice>}
      {history.error && <Notice tone="error">{errorMessage(history.error)}</Notice>}
      {history.data && (historyTask.latestRunInProgress || !history.data.history.some(run =>
        run.finishedAt !== null && run.finishedAt === historyTask.lastFinishedAt)) &&
        <p className="full-value">{historyTask.lastResult || "لا توجد جولات مرتبطة."}</p>}
      {history.data?.history.map(run => <details key={run.id} open={run.finishedAt !== null && run.finishedAt === historyTask.lastFinishedAt}>
        <summary>#{run.id} · {run.title} · {run.finishedAt
          ? `انتهت ${formatDate(run.finishedAt)}`
          : `سُجّلت ${formatDate(run.recordedAt)}`}</summary>
        {run.startedAt && <p>بدأت {formatDate(run.startedAt)}</p>}
        <p className="full-value">{run.detail}</p>
        {run.resumeFrom && <p>الاستئناف من {run.resumeFrom}</p>}
      </details>)}
    </Dialog>}
    {archiveTask && <Dialog open title={archiveTask.archived ? "استرجاع المهمة" : "أرشفة المهمة"}
      onClose={() => { if (!archiveMutation.isPending) setArchiveTask(null); }}
      footer={<Button type="button" disabled={archiveMutation.isPending} onClick={() => archiveMutation.mutate(archiveTask)}>
        {archiveTask.archived ? "استرجاع" : "أرشفة"}
      </Button>}>
      <p>{archiveTask.title}</p>
      {archiveMutation.error && <Notice tone="error">{errorMessage(archiveMutation.error)}</Notice>}
    </Dialog>}
  </>;
}

function NewTaskDialog({ availableSections, companies, onClose }: { availableSections: string[]; companies: Company[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [section, setSection] = useState(sections[0]);
  const create = useMutation({
    mutationFn: (body: object) => api("/ai-tasks", { method: "POST", body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["owner-ai-tasks"] });
      onClose();
    },
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    create.mutate({
      title: form.get("title"),
      description: form.get("description"),
      section: section === "other" ? form.get("otherSection") : section,
      companyId: section === "الشركة" ? Number(form.get("companyId")) : null,
      cadenceHours: Number(form.get("cadenceHours") || 8),
    });
  }
  return <Dialog open title="إضافة مهمة" onClose={() => { if (!create.isPending) onClose(); }}
    footer={<Button type="submit" form="new-ai-task" disabled={create.isPending}>حفظ</Button>}>
    <form id="new-ai-task" onSubmit={submit} className="form-grid">
      <Field label="المهمة"><input name="title" required maxLength={200} /></Field>
      <Field label="القسم"><select value={section} onChange={event => setSection(event.target.value)}>
        {availableSections.map(name => <option key={name}>{name}</option>)}
        <option value="other">قسم آخر</option>
      </select></Field>
      {section === "other" && <Field label="اسم القسم"><input name="otherSection" required maxLength={120} /></Field>}
      {section === "الشركة" && <Field label="الشركة"><select required name="companyId" defaultValue="">
        <option value="">اختر الشركة</option>
        {companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}
      </select></Field>}
      <Field label="الشرح والآلية"><textarea name="description" required rows={5} maxLength={12000} /></Field>
      <Field label="تُنجز كل (ساعات)"><input name="cadenceHours" type="number" min={1} max={8760} defaultValue={8} /></Field>
    </form>
    {create.error && <Notice tone="error">{errorMessage(create.error)}</Notice>}
  </Dialog>;
}
