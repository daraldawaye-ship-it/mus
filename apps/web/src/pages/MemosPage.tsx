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
  memoActionSchema,
  memoCreateSchema,
  memoTypeLabels,
  type CompanyContext,
  type MemoActionInput,
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
type SubmittedMemoAction = {
  payload: MemoActionInput;
  recipient: MemoRecipient | null;
};

const memoEventLabels = {
  created: "إنشاء",
  read: "اطلاع",
  reply: "رد",
  returned: "إعادة إلى المرسل",
  forwarded: "تحويل",
  completion_requested: "طلب اعتماد الإنجاز",
  completed: "اعتماد الإنجاز",
  reopened: "إعادة للاستكمال",
};
const memoStatusLabels = {
  pending: "معلقة",
  awaiting_approval: "بانتظار الاعتماد",
  completed: "منجزة",
};
const memoActionLabels: Record<MemoActionInput["action"], string> = {
  reply: "إضافة رد مع بقاء المسؤول الحالي",
  return: "رد وإعادة إلى المرسل",
  forward: "رد وتحويل إلى موظف آخر",
  "request-completion": "طلب اعتماد الإنجاز من المرسل",
  "approve-completion": "اعتماد الإنجاز وإغلاق المذكرة",
  "reopen-completion": "إعادة للاستكمال",
  complete: "اعتماد الإنجاز وإغلاق المذكرة",
};
const memoActionButtons: Record<MemoActionInput["action"], string> = {
  reply: "إرسال الرد",
  return: "إرسال وإعادة للمرسل",
  forward: "إرسال وتحويل",
  "request-completion": "طلب اعتماد الإنجاز",
  "approve-completion": "اعتماد الإنجاز",
  "reopen-completion": "إعادة للاستكمال",
  complete: "اعتماد الإنجاز وإغلاق المذكرة",
};

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
      : params.get("box") === "following"
        ? "following"
        : params.get("box") === "approval"
          ? "approval"
          : params.get("box") === "completed"
            ? "completed"
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
      accessorKey: "currentName",
      header: "المسؤول الحالي",
      size: 140,
      enableSorting: false,
    },
    {
      id: "status",
      header: "الحالة",
      size: 130,
      enableSorting: false,
      cell: ({ row }) => memoStatusLabels[row.original.status],
    },
    {
      id: "currentRead",
      header: "اطلاع المسؤول",
      size: 120,
      enableSorting: false,
      cell: ({ row }) => (row.original.currentReadAt ? "مقروءة" : "غير مقروءة"),
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
    { value: "approval", label: "بانتظار اعتمادي" },
    { value: "sent", label: "أرسلتها" },
    { value: "following", label: "شاركت فيها" },
    { value: "completed", label: "المنجزة" },
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
          placeholder="العنوان أو المرسل أو المسؤول الحالي"
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
  const canEdit = canView && !!parentEntry?.actionAccess.edit;
  const canPost = canView && !!parentEntry?.actionAccess.post;
  const key = ["memo-detail", user?.id, companyId, memoId];
  const detail = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      api<{ memo: MemoDetail }>(`${base}/memos/${memoId}`, { signal }),
    enabled: !!user && canView && Number.isSafeInteger(memoId) && memoId > 0,
  });
  const memo = detail.data?.memo;
  const readAttempted = useRef<string | null>(null),
    readPending = useRef(false);
  const [readError, setReadError] = useState(""),
    [reading, setReading] = useState(false);
  const draftKey = ["memo-action", user?.id, companyId, memoId];
  const restored = client.getQueryData<SubmittedMemoAction>(draftKey);
  const [submitted, setSubmitted] = useState<SubmittedMemoAction | null>(
    () => restored ?? null,
  );
  const [action, setAction] = useState<MemoActionInput["action"]>(
    restored?.payload.action ?? "reply",
  );
  const [body, setBody] = useState(restored?.payload.body ?? "");
  const [recipient, setRecipient] = useState<MemoRecipient | null>(
    restored?.recipient ?? null,
  );
  const [saving, setSaving] = useState(false),
    [actionError, setActionError] = useState(""),
    [actionSuccess, setActionSuccess] = useState(""),
    [conflict, setConflict] = useState(false);
  const savingLock = useRef(false),
    bodyId = useId();
  const locked = saving || !!submitted;
  const canReply = canEdit && !!memo?.canReply;
  const canTransfer = canEdit && !!memo?.canTransfer;
  const canReturn = canTransfer && memo?.currentUserId !== memo?.senderUserId;
  const allowedActions: Record<MemoActionInput["action"], boolean> = {
    reply: canReply,
    return: canReturn,
    forward: canTransfer,
    "request-completion": canPost && !!memo?.canRequestCompletion,
    "approve-completion": canPost && !!memo?.canApproveCompletion,
    "reopen-completion": canPost && !!memo?.canReopenCompletion,
    complete: canPost && !!memo?.canComplete,
  };
  const actionAllowed = allowedActions[action];
  const availableAction = (
    Object.keys(memoActionLabels) as MemoActionInput["action"][]
  ).find((value) => allowedActions[value]);
  const canAct = !!availableAction;
  useEffect(() => {
    if (!locked && !body.trim() && !actionAllowed && availableAction)
      setAction(availableAction);
  }, [locked, body, actionAllowed, availableAction]);
  const readToken = memo
    ? `${memo.currentAssignmentRevision}:${memo.events.reduce(
        (latest, event) =>
          event.kind !== "created" && event.kind !== "read"
            ? Math.max(latest, event.id)
            : latest,
        0,
      )}`
    : null;
  function applyDetail(result: { memo: MemoDetail }) {
    client.setQueryData<{ memo: MemoDetail }>(key, (previous) =>
      previous && previous.memo.revision > result.memo.revision
        ? previous
        : result,
    );
  }
  async function recordRead() {
    if (!memo || !canView || readPending.current) return;
    readAttempted.current = readToken;
    readPending.current = true;
    setReading(true);
    setReadError("");
    try {
      const result = await api<{ memo: MemoDetail }>(
        `${base}/memos/${memoId}/read`,
        { method: "POST", body: {}, signal: guard.signal },
      );
      if (!guard.isCurrent()) return;
      applyDetail(result);
      void refreshMemos(client, user?.id, companyId);
    } catch (cause) {
      if (guard.isCurrent()) setReadError(errorMessage(cause));
    } finally {
      readPending.current = false;
      if (guard.isCurrent()) setReading(false);
    }
  }
  useEffect(() => {
    if (memo && canView && readToken && readAttempted.current !== readToken)
      void recordRead();
  }, [memo, canView, readToken, reading]);
  useEffect(() => {
    if (!locked) return;
    const preventLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventLeave);
    return () => window.removeEventListener("beforeunload", preventLeave);
  }, [locked]);
  async function sendAction(event: FormEvent) {
    event.preventDefault();
    if (savingLock.current || !memo || (!actionAllowed && !submitted)) return;
    if (!submitted && action === "forward" && !recipient) {
      setActionError("اختر الموظف الذي تريد تحويل المذكرة إليه.");
      return;
    }
    const retry = !!submitted;
    const parsed = memoActionSchema.safeParse(
      submitted?.payload ?? {
        action,
        body,
        revision: memo.revision,
        idempotencyKey: crypto.randomUUID(),
        ...(action === "forward" ? { recipientEmployeeId: recipient!.id } : {}),
      },
    );
    if (!parsed.success) {
      setActionError(
        parsed.error.issues.map((issue) => issue.message).join(" · "),
      );
      return;
    }
    const frozen: SubmittedMemoAction = {
      payload: parsed.data,
      recipient:
        submitted?.recipient ?? (action === "forward" ? recipient : null),
    };
    client.setQueryDefaults(["memo-action"], { gcTime: Infinity });
    client.setQueryData(draftKey, frozen);
    setSubmitted(frozen);
    savingLock.current = true;
    setSaving(true);
    setActionError("");
    setActionSuccess("");
    setConflict(false);
    try {
      const result = await api<{ memo: MemoDetail }>(
        `${base}/memos/${memoId}/actions`,
        { method: "POST", body: frozen.payload, signal: guard.signal },
      );
      if (!guard.isCurrent()) return;
      client.removeQueries({ queryKey: draftKey, exact: true });
      setSubmitted(null);
      setBody("");
      setRecipient(null);
      setAction("reply");
      applyDetail(result);
      const successMessages: Record<MemoActionInput["action"], string> = {
        reply: "تم تسجيل الرد داخل المذكرة.",
        return: `تمت إعادة المذكرة إلى المرسل: ${memo.senderName}.`,
        forward: `تم تحويل المذكرة إلى ${frozen.recipient?.name ?? "الموظف المحدد"}.`,
        "request-completion": "تم إرسال طلب اعتماد الإنجاز إلى المرسل.",
        "approve-completion": "تم اعتماد الإنجاز وإغلاق المذكرة.",
        "reopen-completion": "تمت إعادة المذكرة للاستكمال.",
        complete: "تم اعتماد الإنجاز وإغلاق المذكرة.",
      };
      setActionSuccess(successMessages[frozen.payload.action]);
      void refreshMemos(client, user?.id, companyId);
    } catch (cause) {
      if (!guard.isCurrent()) return;
      setActionError(errorMessage(cause));
      // A known initial rejection permits editing the same draft. An uncertain
      // earlier request retains its UUID and payload until its result is known.
      if (
        !retry &&
        cause instanceof ApiFailure &&
        cause.status >= 400 &&
        cause.status < 500
      ) {
        client.removeQueries({ queryKey: draftKey, exact: true });
        setSubmitted(null);
        if (cause.status === 409) {
          setConflict(true);
          void detail.refetch();
        }
      }
    } finally {
      savingLock.current = false;
      if (guard.isCurrent()) setSaving(false);
    }
  }
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
              <dt>المستلم الأول</dt>
              <dd>{memo.recipientName}</dd>
              <dt>المسؤول الحالي</dt>
              <dd>{memo.currentName}</dd>
              <dt>استلم المتابعة</dt>
              <dd>{time(memo.currentAssignedAt)}</dd>
              <dt>النوع</dt>
              <dd>{memoTypeLabels[memo.type]}</dd>
              <dt>الحالة</dt>
              <dd>{memoStatusLabels[memo.status]}</dd>
              <dt>وقت الإرسال</dt>
              <dd>{time(memo.createdAt)}</dd>
              {memo.completionRequestedAt && (
                <>
                  <dt>طلب الإنجاز بواسطة</dt>
                  <dd>{memo.completionRequestedByName ?? "—"}</dd>
                  <dt>وقت طلب الاعتماد</dt>
                  <dd>{time(memo.completionRequestedAt)}</dd>
                </>
              )}
              {memo.completedAt && (
                <>
                  <dt>اعتمد الإنجاز</dt>
                  <dd>{memo.completedByName ?? "—"}</dd>
                  <dt>وقت الإنجاز</dt>
                  <dd>{time(memo.completedAt)}</dd>
                </>
              )}
              <dt>اطلاع المسؤول الحالي</dt>
              <dd>
                {memo.currentReadAt
                  ? `مقروءة · ${time(memo.currentReadAt)}`
                  : "غير مقروءة"}
              </dd>
              <dt>اطلاعك</dt>
              <dd>{memo.readAt ? time(memo.readAt) : "جارٍ تسجيل الاطلاع…"}</dd>
            </dl>
          </Card>
          <Card title="شرح المذكرة">
            <p className="memo-body">{memo.body}</p>
          </Card>
          {(canAct || submitted || actionError || actionSuccess) && (
            <Card title="الرد والمتابعة">
              <form
                className="form-stack"
                onSubmit={(event) => void sendAction(event)}
              >
                {actionSuccess && (
                  <Notice tone="success">{actionSuccess}</Notice>
                )}
                {actionError && <Notice tone="error">{actionError}</Notice>}
                {conflict && (
                  <Notice tone="warning">
                    تغيرت المذكرة أثناء عملك. راجع المسؤول الحالي والسجل قبل
                    إعادة الإرسال؛ ملاحظاتك محفوظة هنا.
                    <Button
                      variant="ghost"
                      disabled={detail.isFetching}
                      onClick={() => void detail.refetch()}
                    >
                      تحديث المذكرة
                    </Button>
                  </Notice>
                )}
                {submitted && !saving && (
                  <Notice tone="warning">
                    لم تتأكد نتيجة الإرسال بعد. أعد المحاولة بنفس الإجراء للتحقق
                    دون تكراره.
                  </Notice>
                )}
                {(canAct || submitted) && (
                  <>
                    <Select
                      label="الإجراء"
                      value={action}
                      disabled={locked}
                      onChange={(event) => {
                        setAction(
                          event.target.value as MemoActionInput["action"],
                        );
                        setActionError("");
                        setConflict(false);
                      }}
                    >
                      {(
                        Object.entries(memoActionLabels) as [
                          MemoActionInput["action"],
                          string,
                        ][]
                      )
                        .filter(
                          ([value]) =>
                            allowedActions[value] || action === value,
                        )
                        .map(([value, label]) => (
                          <option
                            key={value}
                            value={value}
                            disabled={!allowedActions[value] && !submitted}
                          >
                            {label}
                          </option>
                        ))}
                    </Select>
                    {action === "forward" &&
                      (locked ? (
                        <Field
                          label="تحويل إلى"
                          value={
                            submitted?.recipient?.name ?? recipient?.name ?? ""
                          }
                          readOnly
                        />
                      ) : (
                        <ServerLookup<MemoRecipient>
                          companyId={companyId}
                          resource={`${base}/memos/recipients`}
                          label="تحويل إلى"
                          value={recipient}
                          onChange={setRecipient}
                          display={(item) => item.name}
                          required
                          emptyLabel="اختر موظفًا فعالًا"
                        />
                      ))}
                    {action === "return" && (
                      <p className="muted">
                        ستنتقل مسؤولية المتابعة إلى المرسل: {memo.senderName}.
                      </p>
                    )}
                    {action === "request-completion" && (
                      <p className="muted">
                        سيعود طلب الإنجاز إلى المرسل {memo.senderName} للمراجعة
                        والاعتماد.
                      </p>
                    )}
                    {action === "reopen-completion" && (
                      <p className="muted">
                        ستعود المذكرة إلى{" "}
                        {memo.completionRequestedByName ??
                          "من طلب اعتماد الإنجاز"}{" "}
                        لاستكمال المطلوب.
                      </p>
                    )}
                    {(action === "approve-completion" ||
                      action === "complete") && (
                      <p className="muted">سيُعتمد الإنجاز وتُغلق المذكرة.</p>
                    )}
                    <div className="field">
                      <label htmlFor={bodyId}>
                        {action === "request-completion" ||
                        action === "complete"
                          ? "ما تم إنجازه"
                          : action === "approve-completion"
                            ? "ملاحظات الاعتماد"
                            : action === "reopen-completion"
                              ? "سبب الإعادة للاستكمال"
                              : "نص الرد"}
                      </label>
                      <textarea
                        className="memo-textarea"
                        id={bodyId}
                        value={body}
                        onChange={(event) => setBody(event.target.value)}
                        disabled={locked}
                        required
                        maxLength={20000}
                        rows={4}
                      />
                    </div>
                    <div className="memo-action-buttons">
                      <Button
                        type="submit"
                        disabled={saving || (!submitted && !actionAllowed)}
                      >
                        {saving
                          ? "جارٍ الإرسال…"
                          : submitted
                            ? "إعادة محاولة الإرسال"
                            : memoActionButtons[action]}
                      </Button>
                    </div>
                  </>
                )}
              </form>
            </Card>
          )}
          <Card title="سجل المذكرة">
            <dl className="details-list">
              {memo.events.map((event) => (
                <div key={event.id} className="memo-event">
                  <dt>{memoEventLabels[event.kind]}</dt>
                  <dd>
                    {event.actorName} · {time(event.createdAt)}
                    {event.targetName && <span> · إلى {event.targetName}</span>}
                    {event.body && (
                      <p className="memo-body memo-event-body">{event.body}</p>
                    )}
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
