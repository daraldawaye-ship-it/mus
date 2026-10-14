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
  memoFollowerCommentSchema,
  memoCreateSchema,
  type OptionDefinition,
  type MemoOptionValueInput,
  memoTypeLabels,
  type CompanyContext,
  type MemoActionInput,
  type MemoCreateInput,
  type MemoDetail,
  type MemoFollowerInput,
  type MemoLinksInput,
  type MemoList,
  type MemoRecipient,
  type MemoSummary,
  type MemoType,
} from "../../../../packages/contracts/src/index";
import { ApiFailure, api, useScopeGuard, useSession } from "../api";
import { usePageDirectory } from "../page-directory";
import { errorMessage, ServerLookup } from "../phase2";
import { MemoFollowersEditor } from "../MemoFollowersEditor";
import { MemoLinksEditor, emptyMemoLinks } from "../MemoLinksEditor";
import {MemoFollowupEditor} from "../MemoFollowupEditor";
import { MemoOptionFields, memoOptionLabel } from "../MemoOptionFields";
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
  follower_comment: "تعليق متابع",
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
        : params.get("box") === "deferred"
          ? "deferred"
        : params.get("box") === "watching"
          ? "watching"
        : params.get("box") === "approval"
          ? "approval"
          : params.get("box") === "completed"
            ? "completed"
            : params.get("box") === "all" && context.general
              ? "all"
              : "required";
  const query = params.get("q") ?? "";
  const optionKey=params.get("optionKey")??"";
  const optionValue=params.get("optionValue")??"";
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
    queryKey: ["list", user?.id, scope, box, query, optionKey, optionValue, page, pageSize, sort],
    queryFn: ({ signal }) =>
      api<MemoList>(
        `${base}/memos?${new URLSearchParams({
          box,q:query,page:String(page),pageSize:String(pageSize),sort,
          ...(optionKey && optionValue!==""?{optionKey,optionValue}:{}),
        })}`,
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
  const [followers, setFollowers] = useState<MemoFollowerInput[]>(restored?.payload.followers ?? []);
  const [links, setLinks] = useState<MemoLinksInput>(restored?.payload.links ?? emptyMemoLinks());
  const optionDefinitions = useQuery({
    queryKey:["memo-definitions",user?.id,companyId],
    queryFn:({signal})=>api<{definitions:OptionDefinition[]}>(`${base}/memos/options`,{signal}),
    enabled:!!user && canView,
  });
  const [optionInputs,setOptionInputs] = useState<MemoOptionValueInput[]>(restored?.payload.options??[]);
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
        followers,
        links,
        options:optionInputs,
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
    ...(list.data?.optionDefinitions??[]).map((definition):ColumnDef<MemoSummary,unknown>=>({
      id:`option-${definition.id}`,header:definition.name,size:140,enableSorting:false,
      cell:({row})=>memoOptionLabel(definition,row.original.optionValues?.[definition.key]??null),
    })),
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
    { value: "watching", label: "أتابعها" },
    { value: "deferred", label: "المؤجلة" },
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
        <div className="form-grid">
          <Select label="تصفية حسب خاصية" value={optionKey}
            onChange={event=>filter({optionKey:event.target.value,optionValue:null,page:null})}>
            <option value="">بدون تصفية إضافية</option>
            {(list.data?.searchOptions??[]).map(def=>
              <option value={def.key} key={def.id}>{def.name}</option>)}
          </Select>
          {optionKey && (()=>{
            const def=list.data?.searchOptions?.find(d=>d.key===optionKey);
            if(def?.valueType==="boolean")return <Select label="قيمة الخاصية" value={optionValue}
              onChange={event=>filter({optionValue:event.target.value,page:null})}>
              <option value="">اختر</option><option value="true">نعم</option><option value="false">لا</option>
            </Select>;
            if(def?.valueType==="list")return <Select label="قيمة الخاصية" value={optionValue}
              onChange={event=>filter({optionValue:event.target.value,page:null})}>
              <option value="">اختر</option>
              {def.choices.map(choice=><option key={choice.key} value={choice.key}>{choice.label}</option>)}
            </Select>;
            return <Field label="قيمة الخاصية" value={optionValue}
              onChange={event=>filter({optionValue:event.target.value,page:null})}/>;
          })()}
        </div>
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
          <fieldset className="form-stack" disabled={locked || !canCreate}>
            <legend>صفحة المتابعة والمرجع المرتبط</legend>
            <MemoLinksEditor companyId={companyId} value={links} onChange={setLinks}
              disabled={locked || !canCreate} />
          </fieldset>
          <fieldset className="form-stack" disabled={locked || !canCreate}>
            <legend>خصائص المذكرة الإضافية</legend>
            {optionDefinitions.error && <Notice tone="warning">
              تعذر تحميل الخصائص: {errorMessage(optionDefinitions.error)}
            </Notice>}
            <MemoOptionFields definitions={optionDefinitions.data?.definitions??[]}
              values={submitted?.payload.options??optionInputs}
              onChange={setOptionInputs} defaults disabled={locked || !canCreate}/>
          </fieldset>
          <fieldset className="form-stack" disabled={locked || !canCreate}>
            <legend>المتابعون وصلاحياتهم</legend>
            <MemoFollowersEditor companyId={companyId}
              value={submitted?.payload.followers ?? followers}
              onChange={setFollowers} disabled={locked || !canCreate} />
          </fieldset>
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
  const [optionsDraft,setOptionsDraft] = useState<MemoOptionValueInput[]|null>(null);
  const [optionsSaving,setOptionsSaving] = useState(false);
  const [optionsError,setOptionsError] = useState("");
  const [optionsNotice,setOptionsNotice] = useState("");
  const [linksDraft,setLinksDraft] = useState<MemoLinksInput|null>(null);
  const [linksSaving,setLinksSaving] = useState(false);
  const [linksError,setLinksError] = useState("");
  const [linksNotice,setLinksNotice] = useState("");
  const [followersDraft, setFollowersDraft] = useState<MemoFollowerInput[] | null>(null);
  const [followersSaving, setFollowersSaving] = useState(false);
  const [followersMessage, setFollowersMessage] = useState("");
  const [followersError, setFollowersError] = useState("");
  const [commentBody, setCommentBody] = useState("");
  const [commentPending, setCommentPending] = useState<{body:string;idempotencyKey:string}|null>(null);
  const [commentSaving, setCommentSaving] = useState(false);
  const [commentMessage, setCommentMessage] = useState("");
  const [commentError, setCommentError] = useState("");
  const commentLock = useRef(false);
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
  async function postFollowerComment(event: FormEvent) {
    event.preventDefault();
    if(!memo || !memo.canComment || commentLock.current) return;
    const frozen=commentPending ?? {
      body:commentBody,idempotencyKey:crypto.randomUUID(),
    };
    const parsed=memoFollowerCommentSchema.safeParse(frozen);
    if(!parsed.success) {
      setCommentError("أدخل تعليقًا صالحًا.");
      return;
    }
    commentLock.current=true;
    setCommentPending(frozen);
    setCommentSaving(true);
    setCommentError("");
    setCommentMessage("");
    const retry=!!commentPending;
    try {
      const result=await api<{memo:MemoDetail}>(`${base}/memos/${memoId}/comments`,{
        method:"POST",body:frozen,signal:guard.signal,
      });
      if(!guard.isCurrent()) return;
      applyDetail(result);
      setCommentPending(null);
      setCommentBody("");
      setCommentMessage("تم إضافة التعليق دون نقل مسؤولية المذكرة.");
      void refreshMemos(client,user?.id,companyId);
    } catch(cause) {
      if(!guard.isCurrent()) return;
      setCommentError(errorMessage(cause));
      if(!retry && cause instanceof ApiFailure && cause.status >=400 && cause.status<500)
        setCommentPending(null);
    } finally {
      commentLock.current=false;
      if(guard.isCurrent()) setCommentSaving(false);
    }
  }
  async function saveOptions() {
    if(!memo || !memo.canManageOptions || optionsDraft===null || optionsSaving || !optionsDraft.length)return;
    setOptionsSaving(true);setOptionsError("");setOptionsNotice("");
    try{
      const result=await api<{memo:MemoDetail}>(`${base}/memos/${memoId}/options`,{
        method:"PUT",body:{revision:memo.optionRevision,values:optionsDraft},signal:guard.signal,
      });
      if(!guard.isCurrent())return;
      applyDetail(result);
      setOptionsDraft(null);
      setOptionsNotice("تم حفظ الخصائص دون تعديل حالة المذكرة.");
      void refreshMemos(client,user?.id,companyId);
    }catch(cause){
      if(!guard.isCurrent())return;
      setOptionsError(errorMessage(cause));
      if(cause instanceof ApiFailure && cause.status===409) void detail.refetch();
    }finally{if(guard.isCurrent())setOptionsSaving(false);}
  }
  async function saveLinks() {
    if(!memo || !memo.canManageLinks || !linksDraft || linksSaving) return;
    setLinksSaving(true);setLinksError("");setLinksNotice("");
    try{
      const result = await api<{memo:MemoDetail}>(`${base}/memos/${memoId}/links`,{
        method:"PUT",body:{...linksDraft,revision:memo.links.revision},signal:guard.signal,
      });
      if(!guard.isCurrent())return;
      applyDetail(result);
      setLinksDraft(null);
      setLinksNotice("تم حفظ المراجع والصنف والحساب دون تغيير المسؤول أو حالة المذكرة.");
    }catch(cause){
      if(!guard.isCurrent())return;
      setLinksError(errorMessage(cause));
      if(cause instanceof ApiFailure && cause.status===409)void detail.refetch();
    }finally{if(guard.isCurrent())setLinksSaving(false);}
  }
  async function saveFollowers() {
    if (!memo || followersDraft === null || followersSaving || !memo.canManageFollowers) return;
    setFollowersSaving(true);
    setFollowersError("");
    setFollowersMessage("");
    try {
      const result = await api<{ memo: MemoDetail }>(
        `${base}/memos/${memoId}/followers`,
        { method: "PUT",
          body: { revision: memo.followerRevision, followers: followersDraft },
          signal: guard.signal },
      );
      if (!guard.isCurrent()) return;
      applyDetail(result);
      setFollowersDraft(null);
      setFollowersMessage("تم تحديث المتابعين والصلاحيات.");
      void refreshMemos(client, user?.id, companyId);
    } catch(cause) {
      if (!guard.isCurrent()) return;
      setFollowersError(errorMessage(cause));
      if (cause instanceof ApiFailure && cause.status === 409) void detail.refetch();
    } finally {
      if (guard.isCurrent()) setFollowersSaving(false);
    }
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
          <Card title="صفحة المتابعة والمراجع المرتبطة">
            {linksNotice && <Notice tone="success">{linksNotice}</Notice>}
            {linksError && <Notice tone="error">{linksError}</Notice>}
            {linksDraft === null ? (
              <div className="form-stack">
                {([
                  ["صفحة المتابعة",memo.links.followPage,memo.links.hiddenFollowPage],
                  ["التقرير أو الصفحة المرجعية",memo.links.referencePage,memo.links.hiddenReferencePage],
                ] as const).map(([label,ref,hidden]) => (
                  <p key={label}>{label}: {" "}
                    {ref ? <Link className="button button-secondary button-compact" to={ref.href}>
                      فتح {ref.label}{ref.recordId? ` #${ref.recordId}`:""}
                    </Link> : hidden ? "بيانات محجوبة لعدم وجود صلاحية" : "—"}
                  </p>
                ))}
                <p>الصنف: {memo.links.item ?
                  <Link to={memo.links.item.href}>{memo.links.item.label}</Link> :
                  memo.links.hiddenItem?"محجوب لعدم وجود صلاحية":"—"}</p>
                <p>الحساب: {memo.links.account ?
                  <Link to={memo.links.account.href}>{memo.links.account.label}</Link> :
                  memo.links.hiddenAccount?"محجوب لعدم وجود صلاحية":"—"}</p>
                {memo.canManageLinks && <Button variant="secondary" onClick={() => {
                  setLinksError("");setLinksNotice("");
                  setLinksDraft({
                    followPage:memo.links.followPage?{
                      pageKey:memo.links.followPage.pageKey,recordId:memo.links.followPage.recordId}:null,
                    referencePage:memo.links.referencePage?{
                      pageKey:memo.links.referencePage.pageKey,recordId:memo.links.referencePage.recordId}:null,
                    itemId:memo.links.item?.id??null,accountId:memo.links.account?.id??null,
                  });
                }}>تعديل الروابط والخصائص الأساسية</Button>}
              </div>
            ) : <div className="form-stack">
              <MemoLinksEditor companyId={companyId} value={linksDraft}
                onChange={setLinksDraft} existing={memo.links} disabled={linksSaving}/>
              <div className="memo-action-buttons">
                <Button disabled={linksSaving} onClick={() => void saveLinks()}>
                  {linksSaving?"جارٍ الحفظ…":"حفظ الروابط"}</Button>
                <Button disabled={linksSaving} variant="secondary" onClick={() => setLinksDraft(null)}>إلغاء</Button>
              </div>
            </div>}
            {!!memo.links.changes.length && <div className="form-stack">
              <h3>سجل تعديل المراجع</h3>
              {memo.links.changes.map(change=><p key={change.revision} className="muted">
                {change.actorName} · {time(change.createdAt)} · الإصدار {change.revision}
              </p>)}
            </div>}
          </Card>
          <Card title="الخصائص الإضافية">
            <p className="muted">الخصائص وصفية، ولا تغير مسؤول التنفيذ أو التنبيهات أو اعتماد الإنجاز.</p>
            {optionsNotice && <Notice tone="success">{optionsNotice}</Notice>}
            {optionsError && <Notice tone="error">{optionsError}</Notice>}
            {optionsDraft===null ? (
              <div className="form-stack">
                {memo.optionDefinitions.filter(def=>def.showOnCard).map(def=>{
                  const value=memo.optionValues.find(v=>v.definitionId===def.id)?.value??null;
                  return <p key={def.id}>{def.name}: {memoOptionLabel(def,value)}</p>;
                })}
                {!memo.optionDefinitions.some(def=>def.showOnCard) &&
                  <p className="muted">لا توجد خصائص ظاهرة في كرت المذكرة.</p>}
                {memo.canManageOptions && <Button variant="secondary" onClick={()=>{
                  setOptionsError("");setOptionsNotice("");setOptionsDraft([]);
                }}>تعديل الخصائص</Button>}
              </div>
            ) : <div className="form-stack">
              <MemoOptionFields definitions={memo.optionDefinitions}
                values={[...memo.optionValues.filter(v=>!optionsDraft.some(ch=>ch.definitionId===v.definitionId)),
                  ...optionsDraft]}
                onChange={all=>setOptionsDraft(all.filter(v=>{
                  const previous=memo.optionValues.find(saved=>saved.definitionId===v.definitionId)?.value??null;
                  return previous!==v.value;
                }))}
                disabled={optionsSaving}/>
              <div className="memo-action-buttons">
                <Button disabled={optionsSaving || !optionsDraft.length} onClick={()=>void saveOptions()}>
                  {optionsSaving?"جارٍ الحفظ…":"حفظ الخصائص"}</Button>
                <Button variant="secondary" disabled={optionsSaving} onClick={()=>setOptionsDraft(null)}>إلغاء</Button>
              </div>
            </div>}
            {!!memo.optionChanges.length && <div className="form-stack">
              <h3>سجل تغييرات الخصائص</h3>
              {memo.optionChanges.map(change=><p key={change.revision} className="muted">
                {change.actorName} · {time(change.createdAt)} · الإصدار {change.revision}
              </p>)}
            </div>}
          </Card>
          <Card title="المتابعون وصلاحياتهم">
            <p className="muted">لا تنقل هذه المتابعة التكليف، ولا تمنح سلطة التحويل أو اعتماد الإنجاز.</p>
            {followersMessage && <Notice tone="success">{followersMessage}</Notice>}
            {followersError && <Notice tone="error">{followersError}</Notice>}
            {followersDraft === null ? (
              <>
                {memo.followers.length ? (
                  <div className="form-stack">
                    {memo.followers.map((f) => <p key={f.id}>
                      {f.kind === "role" ? "الدور" : "الموظف"}: {f.name} — {f.accessLevel === "comment" ? "اطلاع وتعليق" : "اطلاع"}
                      <span className="muted"> · أُضيف {time(f.addedAt)}</span>
                    </p>)}
                  </div>
                ) : <p className="muted">لا يوجد متابعون إضافيون.</p>}
                {memo.canManageFollowers && <Button variant="secondary"
                  onClick={() => {
                    setFollowersError("");setFollowersMessage("");
                    setFollowersDraft(memo.followers.map((f) => f.kind === "employee"
                      ? {kind:"employee",employeeId:f.employeeId!,accessLevel:f.accessLevel}
                      : {kind:"role",roleId:f.roleId!,accessLevel:f.accessLevel}));
                  }}>تعديل المتابعين</Button>}
              </>
            ) : (
              <div className="form-stack">
                <MemoFollowersEditor companyId={companyId} value={followersDraft}
                  onChange={setFollowersDraft} known={memo.followers}
                  disabled={followersSaving} />
                <div className="memo-action-buttons">
                  <Button disabled={followersSaving} onClick={() => void saveFollowers()}>
                    {followersSaving ? "جارٍ الحفظ…" : "حفظ المتابعين"}
                  </Button>
                  <Button variant="secondary" disabled={followersSaving}
                    onClick={() => {setFollowersDraft(null);setFollowersError("");}}>إلغاء</Button>
                </div>
              </div>
            )}
            {memo.followerChanges.length > 0 && (
              <div className="form-stack">
                <h3>سجل تغييرات المتابعة</h3>
                {memo.followerChanges.map(change => (
                  <p key={change.id} className="muted">
                    {change.actorName} · {time(change.createdAt)} · الإصدار {change.revision}
                    {" · "}المتابعون قبل: {change.beforeFollowers.length}
                    {"، بعد: "}{change.afterFollowers.length}
                    {change.beforeFollowers.length === change.afterFollowers.length && " (قد تتضمن تعديلاً لمستوى الوصول)"}
                  </p>
                ))}
              </div>
            )}
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
          {memo.canComment && (
            <Card title="تعليق متابعة">
              <form className="form-stack" onSubmit={(event) => void postFollowerComment(event)}>
                <p className="muted">تعليق المتابع يضاف إلى السجل ولا يغير المسؤول الحالي أو الاعتماد.</p>
                {commentMessage && <Notice tone="success">{commentMessage}</Notice>}
                {commentError && <Notice tone="error">{commentError}</Notice>}
                {commentPending && !commentSaving && <Notice tone="warning">
                  لم يتأكد إرسال التعليق؛ إعادة المحاولة تستخدم نفس الطلب لمنع التكرار.
                </Notice>}
                <div className="field">
                  <label htmlFor="memo-follower-comment">نص التعليق</label>
                  <textarea id="memo-follower-comment" className="memo-textarea"
                    value={commentPending?.body ?? commentBody}
                    onChange={(event) => setCommentBody(event.target.value)}
                    disabled={commentSaving || !!commentPending}
                    maxLength={20000} rows={3} required />
                </div>
                <div><Button type="submit" disabled={commentSaving}>
                  {commentSaving ? "جارٍ الإرسال…" : commentPending ? "إعادة محاولة التعليق" : "إضافة تعليق"}
                </Button></div>
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
