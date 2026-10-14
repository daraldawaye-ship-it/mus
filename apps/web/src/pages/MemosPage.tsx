import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { FileText, RefreshCw } from "lucide-react";
import {
  memoCreateSchema,
  memoTypeLabels,
  type CompanyContext,
  type MemoCreateInput,
  type MemoDetail,
  type MemoList,
  type MemoRecipient,
  type MemoSummary,
  type MemoType,
} from "../../../../packages/contracts/src/index";
import { ApiFailure, api, useScopeGuard, useSession } from "../api";
import { usePageDirectory } from "../page-directory";
import { errorMessage, ServerLookup } from "../phase2";
import {
  Button,
  Card,
  DataTable,
  Dialog,
  Field,
  Notice,
  PageHeader,
  Select,
} from "../ui";

const time = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat("ar-YE", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Asia/Aden",
      }).format(new Date(value))
    : "—";
type SubmittedMemo = { payload: MemoCreateInput; recipient: MemoRecipient };

function refreshMemos(
  client: QueryClient,
  userId: number | undefined,
  companyId: number,
) {
  return Promise.all([
    client.invalidateQueries({
      queryKey: ["list", userId, `company:${companyId}:memos`],
    }),
    client.invalidateQueries({ queryKey: ["notifications", userId] }),
    client.invalidateQueries({
      queryKey: ["list", userId, `company:${companyId}:notifications`],
    }),
  ]);
}

export function MemosPage({ context }: { context: CompanyContext }) {
  const { user } = useSession();
  return (
    <MemosContent key={`${user?.id}:${context.company.id}`} context={context} />
  );
}

function MemosContent({ context }: { context: CompanyContext }) {
  const companyId = context.company.id,
    base = `/companies/${companyId}`,
    scope = `company:${companyId}:memos`;
  const { user } = useSession(),
    client = useQueryClient(),
    guard = useScopeGuard(scope);
  const directory = usePageDirectory(companyId);
  const pageEntry = directory.data?.find(
    (entry) => entry.key === "company.memos",
  );
  const detailEntry = directory.data?.find(
    (entry) => entry.key === "company.memo-detail",
  );
  const canView = !!pageEntry?.enabled && !!pageEntry.actionAccess.view;
  const canCreate = !!pageEntry?.enabled && !!pageEntry.actionAccess.create;
  const canViewDetail =
    !!detailEntry?.enabled && !!detailEntry.actionAccess.view;
  const [params, setParams] = useSearchParams();
  const box =
    params.get("box") === "sent"
      ? "sent"
      : params.get("box") === "all" && context.general
        ? "all"
        : "required";
  const query = params.get("q") ?? "";
  const page = Math.max(1, Math.floor(Number(params.get("page")) || 1));
  const pageSize = [10, 20, 50, 100].includes(Number(params.get("pageSize")))
    ? Number(params.get("pageSize"))
    : 20;
  const sort = params.get("sort") || "createdAt:desc,id:desc";
  const sorting: SortingState = sort
    .split(",")
    .filter(Boolean)
    .map((value) => {
      const [id, direction] = value.split(":");
      return { id, desc: direction === "desc" };
    });
  function filter(values: Record<string, string | null>) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      Object.entries(values).forEach(([key, value]) =>
        value ? next.set(key, value) : next.delete(key),
      );
      return next;
    });
  }
  const list = useQuery({
    queryKey: ["list", user?.id, scope, box, query, page, pageSize, sort],
    queryFn: ({ signal }) =>
      api<MemoList>(
        `${base}/memos?${new URLSearchParams({ box, q: query, page: String(page), pageSize: String(pageSize), sort })}`,
        { signal },
      ),
    enabled: !!user && canView,
  });
  const draftKey = ["memo-create", user?.id, companyId];
  const restored = client.getQueryData<SubmittedMemo>(draftKey);
  const [submitted, setSubmitted] = useState<SubmittedMemo | null>(
    () => restored ?? null,
  );
  const [open, setOpen] = useState(!!restored);
  const [title, setTitle] = useState(restored?.payload.title ?? "");
  const [body, setBody] = useState(restored?.payload.body ?? "");
  const [type, setType] = useState<MemoType>(restored?.payload.type ?? "task");
  const [recipient, setRecipient] = useState<MemoRecipient | null>(
    restored?.recipient ?? null,
  );
  const [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [created, setCreated] = useState<MemoDetail | null>(null);
  const savingLock = useRef(false),
    formId = useId(),
    bodyId = useId();
  const locked = saving || !!submitted;
  useEffect(() => {
    if (!locked) return;
    const preventLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventLeave);
    return () => window.removeEventListener("beforeunload", preventLeave);
  }, [locked]);
  function close() {
    if (locked) return;
    setOpen(false);
    setError("");
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (savingLock.current || (!canCreate && !submitted)) return;
    if (!submitted && !recipient) {
      setError("اختر المستلم من موظفي الشركة الفعالين.");
      return;
    }
    const retry = !!submitted;
    const parsed = memoCreateSchema.safeParse(
      submitted?.payload ?? {
        title,
        body,
        type,
        recipientEmployeeId: recipient!.id,
        idempotencyKey: crypto.randomUUID(),
      },
    );
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join(" · "));
      return;
    }
    const frozen: SubmittedMemo = {
      payload: parsed.data,
      recipient: submitted?.recipient ?? recipient!,
    };
    client.setQueryDefaults(["memo-create"], { gcTime: Infinity });
    client.setQueryData(draftKey, frozen);
    setSubmitted(frozen);
    savingLock.current = true;
    setSaving(true);
    setError("");
    setCreated(null);
    try {
      const result = await api<{ memo: MemoDetail }>(`${base}/memos`, {
        method: "POST",
        body: frozen.payload,
        signal: guard.signal,
      });
      if (!guard.isCurrent()) return;
      client.removeQueries({ queryKey: draftKey, exact: true });
      setSubmitted(null);
      setOpen(false);
      setTitle("");
      setBody("");
      setType("task");
      setRecipient(null);
      setCreated(result.memo);
      void refreshMemos(client, user?.id, companyId);
    } catch (cause) {
      if (!guard.isCurrent()) return;
      setError(errorMessage(cause));
      // A rejected initial request is known not to have saved. An uncertain
      // earlier request keeps its exact payload even if a retry is denied.
      if (
        !retry &&
        cause instanceof ApiFailure &&
        cause.status >= 400 &&
        cause.status < 500
      ) {
        client.removeQueries({ queryKey: draftKey, exact: true });
        setSubmitted(null);
      }
    } finally {
      savingLock.current = false;
      if (guard.isCurrent()) setSaving(false);
    }
  }
  const columns: ColumnDef<MemoSummary, unknown>[] = [
    {
      id: "actions",
      header: "فتح",
      size: 75,
      enableSorting: false,
      cell: ({ row }) =>
        canViewDetail ? (
          <Link
            className="button button-secondary button-compact"
            to={`${base}/memos/${row.original.id}`}
            aria-label={`فتح المذكرة ${row.original.title}`}
          >
            عرض
          </Link>
        ) : (
          "—"
        ),
    },
    { accessorKey: "title", header: "العنوان", size: 240 },
    {
      accessorKey: "type",
      header: "النوع",
      size: 95,
      cell: ({ row }) => memoTypeLabels[row.original.type],
    },
    {
      accessorKey: "senderName",
      header: "المرسل",
      size: 140,
      enableSorting: false,
    },
    {
      accessorKey: "recipientName",
      header: "المستلم",
      size: 140,
      enableSorting: false,
    },
    {
      id: "status",
      header: "الحالة",
      size: 85,
      enableSorting: false,
      cell: () => "معلقة",
    },
    {
      id: "recipientRead",
      header: "اطلاع المستلم",
      size: 120,
      enableSorting: false,
      cell: ({ row }) =>
        row.original.recipientReadAt ? "مقروءة" : "غير مقروءة",
    },
    {
      accessorKey: "createdAt",
      header: "وقت الإرسال",
      size: 175,
      cell: ({ row }) => time(row.original.createdAt),
    },
  ];
  const boxes = [
    { value: "required", label: "مطلوب مني" },
    { value: "sent", label: "أرسلتها" },
    ...(context.general ? [{ value: "all", label: "كل المذكرات" }] : []),
  ];
  return (
    <div className="wallet-page">
      <PageHeader
        title="المذكرات"
        description="التكليفات والاستفسارات والمراجعات وطلبات الاعتماد داخل الشركة."
        actions={
          <>
            <Button
              variant="secondary"
              disabled={!canView || list.isFetching}
              onClick={() => void list.refetch()}
            >
              <RefreshCw size={15} />
              تحديث
            </Button>
            {canCreate && (
              <Button
                onClick={() => {
                  setError("");
                  setCreated(null);
                  setOpen(true);
                }}
              >
                <FileText size={15} />
                إنشاء مذكرة
              </Button>
            )}
          </>
        }
      />
      {created && (
        <Notice tone="success">
          تم إرسال المذكرة إلى {created.recipientName}.{" "}
          {canViewDetail && (
            <Link to={`${base}/memos/${created.id}`}>عرض المذكرة</Link>
          )}
        </Notice>
      )}
      {!canView && (
        <Notice tone="warning">عرض المذكرات غير متاح حاليًا.</Notice>
      )}
      {list.error && (
        <Notice tone="error">
          {errorMessage(list.error)}{" "}
          <Button
            variant="ghost"
            disabled={!canView}
            onClick={() => void list.refetch()}
          >
            إعادة المحاولة
          </Button>
        </Notice>
      )}
      <Card>
        <div
          className="wallet-filters"
          role="tablist"
          aria-label="صناديق المذكرات"
        >
          {boxes.map((item) => (
            <Button
              key={item.value}
              role="tab"
              aria-selected={box === item.value}
              variant={box === item.value ? "primary" : "secondary"}
              onClick={() => filter({ box: item.value, page: null })}
            >
              {item.label}
            </Button>
          ))}
        </div>
        <Field
          label="بحث في المذكرات"
          type="search"
          value={query}
          onChange={(event) => filter({ q: event.target.value, page: null })}
          placeholder="العنوان أو المرسل أو المستلم"
        />
        <DataTable
          columns={columns}
          data={canView ? (list.data?.items ?? []) : []}
          total={canView ? (list.data?.total ?? 0) : 0}
          page={page}
          pageSize={pageSize}
          onPageChange={(value) => filter({ page: String(value) })}
          onPageSizeChange={(value) =>
            filter({ pageSize: String(value), page: null })
          }
          sorting={sorting}
          onSortingChange={(update) => {
            const next =
              typeof update === "function" ? update(sorting) : update;
            filter({
              sort:
                next
                  .map((item) => `${item.id}:${item.desc ? "desc" : "asc"}`)
                  .join(",") || "createdAt:desc,id:desc",
              page: null,
            });
          }}
          loading={list.isFetching}
          ariaLabel="قائمة المذكرات"
        />
      </Card>
      <Dialog
        open={open}
        title="إنشاء مذكرة"
        onClose={close}
        footer={
          <>
            <Button variant="secondary" disabled={locked} onClick={close}>
              إلغاء
            </Button>
            <Button
              type="submit"
              form={formId}
              disabled={saving || (!canCreate && !submitted)}
            >
              {saving
                ? "جارٍ الإرسال…"
                : submitted
                  ? "إعادة محاولة الإرسال"
                  : "إرسال المذكرة"}
            </Button>
          </>
        }
      >
        <form
          id={formId}
          onSubmit={(event) => void save(event)}
          className="form-stack"
        >
          {error && <Notice tone="error">{error}</Notice>}
          {submitted && !saving && (
            <Notice tone="warning">
              لم يتأكد الإرسال بعد. أعد المحاولة بنفس المذكرة للتحقق من النتيجة
              دون تكرارها.
            </Notice>
          )}
          {!canCreate && (
            <Notice tone="warning">إنشاء مذكرات جديدة غير متاح حاليًا.</Notice>
          )}
          <Field
            label="عنوان المذكرة"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            disabled={locked}
            required
            maxLength={200}
          />
          <div className="form-grid">
            <Field label="المرسل" value={user?.displayName ?? ""} readOnly />
            <Select
              label="نوع المذكرة"
              value={type}
              onChange={(event) => setType(event.target.value as MemoType)}
              disabled={locked}
            >
              {Object.entries(memoTypeLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </div>
          {locked || !canCreate ? (
            <Field label="المستلم" value={recipient?.name ?? ""} readOnly />
          ) : (
            <ServerLookup<MemoRecipient>
              companyId={companyId}
              resource={`${base}/memos/recipients`}
              label="المستلم"
              value={recipient}
              onChange={setRecipient}
              display={(item) => item.name}
              required
              emptyLabel="اختر موظفًا فعالًا"
            />
          )}
          <div className="field">
            <label htmlFor={bodyId}>شرح المذكرة</label>
            <textarea
              className="memo-textarea"
              id={bodyId}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              disabled={locked}
              required
              maxLength={20000}
              rows={6}
            />
          </div>
        </form>
      </Dialog>
    </div>
  );
}

export function MemoDetailPage({ context }: { context: CompanyContext }) {
  const { user } = useSession(),
    { memoId } = useParams();
  return (
    <MemoDetailContent
      key={`${user?.id}:${context.company.id}:${memoId}`}
      context={context}
      memoId={Number(memoId)}
    />
  );
}

function MemoDetailContent({
  context,
  memoId,
}: {
  context: CompanyContext;
  memoId: number;
}) {
  const companyId = context.company.id,
    base = `/companies/${companyId}`;
  const { user } = useSession(),
    client = useQueryClient(),
    guard = useScopeGuard(`company:${companyId}:memo:${memoId}`);
  const directory = usePageDirectory(companyId);
  const pageEntry = directory.data?.find(
    (entry) => entry.key === "company.memo-detail",
  );
  const parentEntry = directory.data?.find(
    (entry) => entry.key === "company.memos",
  );
  const canView =
    !!pageEntry?.enabled &&
    !!pageEntry.actionAccess.view &&
    !!parentEntry?.enabled &&
    !!parentEntry.actionAccess.view;
  const key = ["memo-detail", user?.id, companyId, memoId];
  const detail = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      api<{ memo: MemoDetail }>(`${base}/memos/${memoId}`, { signal }),
    enabled: !!user && canView && Number.isSafeInteger(memoId) && memoId > 0,
  });
  const memo = detail.data?.memo;
  const readAttempted = useRef(false),
    readPending = useRef(false);
  const [readError, setReadError] = useState("");
  async function recordRead() {
    if (!memo || memo.readAt || !canView || readPending.current) return;
    readAttempted.current = true;
    readPending.current = true;
    setReadError("");
    try {
      const result = await api<{ memo: MemoDetail }>(
        `${base}/memos/${memoId}/read`,
        { method: "POST", body: {}, signal: guard.signal },
      );
      if (!guard.isCurrent()) return;
      client.setQueryData(key, result);
      void refreshMemos(client, user?.id, companyId);
    } catch (cause) {
      if (guard.isCurrent()) setReadError(errorMessage(cause));
    } finally {
      readPending.current = false;
    }
  }
  useEffect(() => {
    if (memo && canView && !memo.readAt && !readAttempted.current)
      void recordRead();
  }, [memo, canView]);
  return (
    <div className="wallet-page">
      <PageHeader
        title="تفاصيل المذكرة"
        actions={
          <>
            <Link className="button button-secondary" to={`${base}/memos`}>
              المذكرات
            </Link>
            <Button
              variant="secondary"
              disabled={!canView || detail.isFetching}
              onClick={() => void detail.refetch()}
            >
              <RefreshCw size={15} />
              تحديث
            </Button>
          </>
        }
      />
      {!canView && <Notice tone="warning">عرض المذكرة غير متاح حاليًا.</Notice>}
      {detail.error && (
        <Notice tone="error">
          {errorMessage(detail.error)}{" "}
          <Button
            variant="ghost"
            disabled={!canView}
            onClick={() => void detail.refetch()}
          >
            إعادة المحاولة
          </Button>
        </Notice>
      )}
      {readError && (
        <Notice tone="warning">
          تعذر تسجيل اطلاعك: {readError}{" "}
          <Button
            variant="ghost"
            disabled={!canView}
            onClick={() => void recordRead()}
          >
            إعادة المحاولة
          </Button>
        </Notice>
      )}
      {canView && !memo && !detail.error && (
        <Notice>جارٍ تحميل المذكرة…</Notice>
      )}
      {canView && memo && (
        <>
          <Card title={memo.title}>
            <dl className="details-list">
              <dt>المرسل</dt>
              <dd>{memo.senderName}</dd>
              <dt>المستلم</dt>
              <dd>{memo.recipientName}</dd>
              <dt>النوع</dt>
              <dd>{memoTypeLabels[memo.type]}</dd>
              <dt>الحالة</dt>
              <dd>معلقة</dd>
              <dt>وقت الإرسال</dt>
              <dd>{time(memo.createdAt)}</dd>
              <dt>اطلاع المستلم</dt>
              <dd>
                {memo.recipientReadAt
                  ? `مقروءة · ${time(memo.recipientReadAt)}`
                  : "غير مقروءة"}
              </dd>
              <dt>اطلاعك</dt>
              <dd>{memo.readAt ? time(memo.readAt) : "جارٍ تسجيل الاطلاع…"}</dd>
            </dl>
          </Card>
          <Card title="شرح المذكرة">
            <p className="memo-body">{memo.body}</p>
          </Card>
          <Card title="سجل المذكرة">
            <dl className="details-list">
              {memo.events.map((event) => (
                <div key={event.id} className="memo-event">
                  <dt>{event.kind === "created" ? "إنشاء" : "اطلاع"}</dt>
                  <dd>
                    {event.actorName} · {time(event.createdAt)}
                  </dd>
                </div>
              ))}
            </dl>
          </Card>
        </>
      )}
    </div>
  );
}
