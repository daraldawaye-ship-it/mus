import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  accountBalanceApprovalSchema,
  accountBalanceFollowUpSchema,
  accountStatisticsMetricDefinitions,
  accountStatisticsReportGroupLabels,
  accountStatisticCell,
  type AccountBalanceApproval,
  type AccountBalanceApprovalInput,
  type AccountBalanceFollowUp,
  type AccountBalanceFollowUpInput,
  type AccountBalanceStatistics,
  type AccountStatisticsReportGroup,
  type AccountStatisticsMetricDefinition,
} from "../../../packages/contracts/src/index";
import { api, ApiFailure, useScopeGuard, useSession } from "./api";
import { formatMoney } from "./format-money";
import { usePageDirectory } from "./page-directory";
import { errorMessage } from "./phase2";
import { Button, Card, Field, Notice, Select } from "./ui";

export type AccountStatisticsCardProps = {
  companyId: number;
  account: {
    id: number;
    code: string;
    name: string;
    kind?: "group" | "posting";
  };
  asOfDate?: string;
  compact?: boolean;
  onChanged?: () => void;
};

type PendingAction =
  | { action: "followup"; payload: AccountBalanceFollowUpInput }
  | {
      action: "approval";
      payload: AccountBalanceApprovalInput;
      currencyCode: string;
    };

/** Only the current actor's submitted requests in this company are recoverable. */
export function usePendingAccountStatisticsActions(
  companyId: number,
): readonly number[] {
  const { user } = useSession();
  const cache = useQueryClient().getQueryCache();
  const subscribe = useCallback(
    (notify: () => void) => cache.subscribe(notify),
    [cache],
  );
  const getSnapshot = useCallback(() => {
    if (!user) return "";
    return cache
      .getAll()
      .filter((query) => {
        const key = query.queryKey;
        const pending = query.state.data as PendingAction | null | undefined;
        return (
          key[0] === "account-statistics-action" &&
          key[1] === user.id &&
          key[2] === companyId &&
          typeof key[3] === "number" &&
          !!pending &&
          (pending.action === "followup" || pending.action === "approval")
        );
      })
      .map((query) => query.queryKey[3] as number)
      .sort((left, right) => left - right)
      .join(",");
  }, [cache, user?.id, companyId]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(
    () => (snapshot ? snapshot.split(",").map(Number) : []),
    [snapshot],
  );
}

const atAden = (value: string) =>
  new Intl.DateTimeFormat("ar-YE", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Aden",
  }).format(new Date(value));
const count = (value: string) => BigInt(value).toLocaleString("en-US");
const amount = (value: string, currency: string) =>
  `${formatMoney(value)} ${currency}`;

/** The key remounts all form state on an actor, company or account change. */
export function AccountStatisticsCard(props: AccountStatisticsCardProps) {
  const { user } = useSession();
  if (props.account.kind === "group") return null;
  return (
    <AccountStatisticsFields
      key={`${user?.id}:${props.companyId}:${props.account.id}:${props.asOfDate ?? "today"}`}
      {...props}
    />
  );
}

function AccountStatisticsFields({
  companyId,
  account,
  asOfDate,
  compact = false,
  onChanged,
}: AccountStatisticsCardProps) {
  const { user } = useSession();
  const client = useQueryClient();
  const directory = usePageDirectory(companyId);
  const entry = directory.data?.find(
    (page) => page.key === "company.account-statistics",
  );
  const canView = !!entry?.enabled && !!entry.actionAccess.view;
  const guard = useScopeGuard(
    `company:${companyId}:account:${account.id}:statistics:${asOfDate ?? "today"}`,
  );
  const queryKey = [
    "account-statistics",
    user?.id,
    companyId,
    account.id,
    asOfDate ?? "today",
  ];
  const pendingKey = [
    "account-statistics-action",
    user?.id,
    companyId,
    account.id,
  ];
  // This is local query-cache state, never an automatic network request.
  // Retain the exact request across dialog closure and route navigation.
  const pendingQuery = useQuery<PendingAction | null>({
    queryKey: pendingKey,
    queryFn: async () => null,
    initialData: null,
    enabled: false,
    gcTime: Infinity,
  });
  const submitted = pendingQuery.data ?? null;
  const statistics = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      api<{ statistics: AccountBalanceStatistics }>(
        `/companies/${companyId}/accounts/${account.id}/statistics${asOfDate ? `?asOfDate=${encodeURIComponent(asOfDate)}` : ""}`,
        { signal },
      ),
    enabled: !!user && canView,
    staleTime: 0,
  });
  // Never retain a previously authorized snapshot on screen after a current
  // directory denial or an API failure during a permissions refresh.
  const data =
    canView && !statistics.error ? statistics.data?.statistics : undefined;
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const [confirmedQuote, setConfirmedQuote] = useState<string | null>(null);
  const [group, setGroup] = useState<AccountStatisticsReportGroup>("balances");
  const savingLock = useRef(false);
  const locked = saving || !!submitted;
  const canFollowUp =
    !!data?.capabilities.canFollowUp && !!entry?.actionAccess.create;
  const canApprove =
    !!data?.capabilities.canApprove && !!entry?.actionAccess.post;
  const displayedQuote = data ? JSON.stringify(data.approvalQuote) : null;
  const confirmApproval =
    displayedQuote !== null && confirmedQuote === displayedQuote;
  const reportQuery = new URLSearchParams({ accountId: String(account.id) });
  if (asOfDate) reportQuery.set("asOfDate", asOfDate);

  useEffect(() => {
    if (!submitted) return;
    const preventLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventLeave);
    return () => window.removeEventListener("beforeunload", preventLeave);
  }, [submitted]);

  async function refresh() {
    await Promise.all([
      client.invalidateQueries({
        queryKey: ["account-statistics", user?.id, companyId],
      }),
      client.invalidateQueries({
        queryKey: ["account-statistics-report", user?.id, companyId],
      }),
      client.invalidateQueries({
        queryKey: ["list", user?.id, `company:${companyId}:account-statistics`],
      }),
      client.invalidateQueries({
        queryKey: ["list", user?.id, `company:${companyId}:accounts`],
      }),
    ]);
  }

  async function submit(action: PendingAction["action"], event?: FormEvent) {
    event?.preventDefault();
    if (savingLock.current || !user) return;
    // Consult the cache at click time as another card can share this account.
    const prior = client.getQueryData<PendingAction | null>(pendingKey) ?? null;
    if (prior && prior.action !== action) return;
    if (
      !prior &&
      (action === "followup" ? !canFollowUp : !canApprove || !confirmApproval)
    )
      return;
    const retry = !!prior;
    let frozen: PendingAction;
    if (prior) frozen = prior;
    else if (action === "followup") {
      const parsed = accountBalanceFollowUpSchema.safeParse({
        idempotencyKey: crypto.randomUUID(),
        note,
      });
      if (!parsed.success) {
        setError(parsed.error.issues.map((issue) => issue.message).join(" · "));
        return;
      }
      frozen = { action, payload: parsed.data };
    } else {
      if (!data) return;
      const parsed = accountBalanceApprovalSchema.safeParse({
        ...data.approvalQuote,
        idempotencyKey: crypto.randomUUID(),
        note,
      });
      if (!parsed.success) {
        setError(parsed.error.issues.map((issue) => issue.message).join(" · "));
        return;
      }
      frozen = {
        action,
        payload: parsed.data,
        currencyCode: data.currency.code,
      };
    }
    client.setQueryData(pendingKey, frozen);
    savingLock.current = true;
    setSaving(true);
    setError("");
    setNotice("");
    setConflict(false);
    try {
      await api<
        | { followUp: AccountBalanceFollowUp }
        | { approval: AccountBalanceApproval }
      >(
        `/companies/${companyId}/accounts/${account.id}/${frozen.action === "followup" ? "balance-followups" : "balance-approvals"}`,
        { method: "POST", body: frozen.payload, signal: guard.signal },
      );
      // Clearing this exact actor/record receipt is safe even after unmount;
      // announcing success and changing current page state is not.
      const current = client.getQueryData<PendingAction | null>(pendingKey);
      if (current?.payload.idempotencyKey === frozen.payload.idempotencyKey)
        client.setQueryData(pendingKey, null);
      if (!guard.isCurrent()) return;
      setNote("");
      setConfirmedQuote(null);
      setNotice(
        frozen.action === "followup"
          ? "تم تسجيل متابعة الرصيد."
          : "تم اعتماد الرصيد المعروض.",
      );
      await refresh();
      if (guard.isCurrent()) onChanged?.();
    } catch (cause) {
      if (!guard.isCurrent()) return;
      setError(errorMessage(cause));
      // An initial confirmed rejection did not save. A retry of a previously
      // uncertain request must retain its UUID and payload even if now denied.
      if (
        !retry &&
        cause instanceof ApiFailure &&
        cause.status >= 400 &&
        cause.status < 500
      ) {
        client.setQueryData(pendingKey, null);
        setConfirmedQuote(null);
        if (action === "approval" && cause.status === 409) {
          setConflict(true);
          void statistics.refetch();
        }
      }
    } finally {
      savingLock.current = false;
      if (guard.isCurrent()) setSaving(false);
    }
  }

  function metricValue(definition: AccountStatisticsMetricDefinition) {
    if (!data) return "—";
    const cell = accountStatisticCell(data, definition.key);
    if (cell.value === null)
      return cell.unavailableReason === "restricted"
        ? "غير متاح بالصلاحيات الحالية"
        : cell.unavailableReason === "unknown"
          ? "غير مكتمل: التصنيف النقدي لبعض المشتريات مجهول"
          : "لا يوجد سجل";
    const value =
      definition.kind === "money"
        ? amount(cell.value, cell.currencyCode ?? data.currency.code)
        : definition.kind === "count"
          ? count(cell.value)
          : definition.kind === "datetime"
            ? atAden(cell.value)
            : cell.value;
    const reference = cell.source;
    if (!reference) return <bdi>{value}</bdi>;
    const pageKey =
      reference.sourceKind === "invoice"
        ? "company.invoice"
        : "company.financial-document";
    const mayOpen = directory.data?.some(
      (page) => page.key === pageKey && page.enabled && page.actionAccess.view,
    );
    const text = <bdi>{reference.documentNumber}</bdi>;
    return (
      <>
        <bdi>{value}</bdi> ·{" "}
        {mayOpen ? (
          <Link
            to={`/companies/${companyId}/${reference.sourceKind === "invoice" ? "invoices" : "financial-documents"}/${reference.sourceId}`}
          >
            {text}
          </Link>
        ) : (
          text
        )}
        {definition.kind === "money" &&
          cell.baseAmount !== null &&
          cell.baseCurrencyCode !== cell.currencyCode && (
            <span>
              {" "}
              · بالأساسية{" "}
              <bdi>{amount(cell.baseAmount, cell.baseCurrencyCode!)}</bdi>
            </span>
          )}
      </>
    );
  }

  return (
    <Card title="إحصاءات الحساب ومتابعة الرصيد">
      {directory.isPending && (
        <Notice>جارٍ التحقق من صلاحيات الإحصاءات…</Notice>
      )}
      {directory.error && (
        <Notice tone="error">{errorMessage(directory.error)}</Notice>
      )}
      {!directory.isPending && !canView && (
        <Notice tone="warning">
          إحصاءات هذا الحساب غير متاحة بالصلاحيات وإعدادات الصفحات الحالية.
        </Notice>
      )}
      {statistics.isFetching && canView && (
        <Notice>جارٍ تحديث إحصاءات الحساب…</Notice>
      )}
      {statistics.error && canView && (
        <Notice tone="error">
          {errorMessage(statistics.error)}{" "}
          <Button variant="ghost" onClick={() => void statistics.refetch()}>
            إعادة المحاولة
          </Button>
        </Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {notice && <Notice tone="success">{notice}</Notice>}
      {conflict && (
        <Notice tone="warning">
          تغيّر الرصيد أو مصدره. راجع الرصيد المحدّث ثم أكّد الاعتماد من جديد.
        </Notice>
      )}
      {submitted && (
        <Notice tone="warning">
          لم يتأكد استلام نتيجة طلب{" "}
          {submitted.action === "followup" ? "المتابعة" : "الاعتماد"}. أعد الطلب
          نفسه للتحقق من نتيجته.
          {submitted.action === "approval" && (
            <>
              {" "}
              الرصيد المرسل:{" "}
              <bdi>
                {amount(
                  submitted.payload.expectedBalanceBase,
                  submitted.currencyCode,
                )}
              </bdi>{" "}
              حتى <bdi>{submitted.payload.balanceDate}</bdi>.
            </>
          )}
          <p>الملاحظة المرسلة: {submitted.payload.note || "بلا ملاحظة"}</p>
          {(!canView ||
            (submitted.action === "followup" ? !canFollowUp : !canApprove)) && (
            <p>
              لا يمكن بدء إجراء جديد بالصلاحيات وإعدادات الصفحات الحالية. يبقى
              الطلب المحفوظ للتحقق من نتيجته، مع إعادة فحص صلاحيتك في الخادم.
            </p>
          )}
          <Button
            variant="secondary"
            disabled={saving}
            onClick={() => void submit(submitted.action)}
          >
            {saving ? "جارٍ التحقق…" : "إعادة الطلب نفسه"}
          </Button>
        </Notice>
      )}
      {data && (
        <>
          <dl className="details-list">
            <dt>آخر متابعة مسجّلة للرصيد</dt>
            <dd>
              {data.lastFollowUp ? (
                <>
                  <bdi>{atAden(data.lastFollowUp.followedUpAt)}</bdi>
                  {data.lastFollowUp.note && <p>{data.lastFollowUp.note}</p>}
                </>
              ) : (
                "لم تسجّل متابعة بعد"
              )}
            </dd>
            <dt>الرصيد حتى تاريخ التقرير</dt>
            <dd>
              <bdi>{amount(data.balance.currentBase, data.currency.code)}</bdi>{" "}
              · <bdi>{data.asOfDate}</bdi>
            </dd>
            <dt>آخر رصيد معتمد</dt>
            <dd>
              {data.lastApproval ? (
                <>
                  <bdi>
                    {amount(
                      data.lastApproval.balanceBase,
                      data.lastApproval.currency.code,
                    )}
                  </bdi>{" "}
                  حتى <bdi>{data.lastApproval.balanceDate}</bdi> · اعتمد في{" "}
                  <bdi>{atAden(data.lastApproval.createdAt)}</bdi>
                  {data.lastApproval.note && <p>{data.lastApproval.note}</p>}
                  {data.lastApproval.sourceRevision !== data.sourceRevision && (
                    <p className="muted">
                      لقطة اعتماد سابقة؛ تغيّر مصدر الرصيد بعدها.
                    </p>
                  )}
                </>
              ) : (
                "لا يوجد اعتماد مسجّل للبيانات الحالية"
              )}
            </dd>
            {!compact && (
              <>
                <dt>حدود تاريخ التقرير</dt>
                <dd>
                  <bdi>{data.asOfDate}</bdi>؛ يبدأ الأسبوع يوم السبت.
                </dd>
              </>
            )}
            <dt>قيمة الأصناف المرتبطة بالحساب — حالية</dt>
            <dd>
              {data.stock ? (
                <>
                  <bdi>
                    {amount(data.stock.valueBase, data.stock.currency.code)}
                  </bdi>
                  <p className="muted">
                    حسب مورد كرت الصنف، بتاريخ <bdi>{data.stock.asOfDate}</bdi>{" "}
                    · {atAden(data.stock.snapshotAt)}، ومستقلة عن تاريخ التقرير.
                  </p>
                  <p>
                    مورد محدد:{" "}
                    <bdi>
                      {amount(
                        data.stock.confirmedValueBase,
                        data.stock.currency.code,
                      )}
                    </bdi>{" "}
                    · إسناد مستنتج:{" "}
                    <bdi>
                      {amount(
                        data.stock.inferredValueBase,
                        data.stock.currency.code,
                      )}
                    </bdi>
                    .
                  </p>
                  {!compact && (
                    <>
                      <p>
                        أصناف مرتبطة:{" "}
                        <bdi>{count(data.stock.assignedItemCount)}</bdi>، منها
                        مستنتجة:{" "}
                        <bdi>{count(data.stock.inferredItemCount)}</bdi>. أصناف
                        برصيد سالب:{" "}
                        <bdi>{count(data.stock.negativeStockItemCount)}</bdi>،
                        وقيمتها الموقعة{" "}
                        <bdi>
                          {amount(
                            data.stock.negativeStockValueBase,
                            data.stock.currency.code,
                          )}
                        </bdi>
                        .
                      </p>
                    </>
                  )}
                </>
              ) : (
                "غير متاحة بالصلاحيات الحالية"
              )}
            </dd>
          </dl>
          <p className="muted">
            المبالغ من التاريخ المسجّل فقط؛ الموجب مدين والسالب دائن. لا يفترض
            التقرير اكتمال الأرصدة الافتتاحية. الأوقات بتوقيت عدن.
          </p>
          {!compact && (
            <>
              <Select
                label="مجموعة مؤشرات الحساب"
                value={group}
                onChange={(event) =>
                  setGroup(event.target.value as AccountStatisticsReportGroup)
                }
              >
                {Object.entries(accountStatisticsReportGroupLabels).map(
                  ([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ),
                )}
              </Select>
              <dl className="details-list">
                {accountStatisticsMetricDefinitions
                  .filter((definition) => definition.group === group)
                  .map((definition) => (
                    <Fragment key={definition.key}>
                      <dt>{definition.label}</dt>
                      <dd>
                        {metricValue(definition)}
                        {definition.period &&
                          definition.period !== "allTime" && (
                            <small className="muted">
                              {" "}
                              ·{" "}
                              <bdi>
                                {
                                  data.operations.periods[definition.period]
                                    .from
                                }
                              </bdi>{" "}
                              إلى{" "}
                              <bdi>
                                {data.operations.periods[definition.period].to}
                              </bdi>
                            </small>
                          )}
                      </dd>
                    </Fragment>
                  ))}
              </dl>
              <p className="muted">
                المرتجعات والعكس ضمن صافي المبالغ. عدد الحركات العام لا يعرض
                مجموعًا جزئيًا عند حجب بعض مصادره.
              </p>
            </>
          )}
          {!submitted && (canFollowUp || canApprove) && (
            <form
              className="form-stack"
              onSubmit={(event) => void submit("followup", event)}
            >
              <Field
                label="ملاحظة المتابعة أو الاعتماد"
                value={note}
                maxLength={2000}
                disabled={locked}
                onChange={(event) => setNote(event.target.value)}
              />
              {canApprove && (
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={confirmApproval}
                    disabled={locked || statistics.isFetching}
                    onChange={(event) =>
                      setConfirmedQuote(
                        event.target.checked ? displayedQuote : null,
                      )
                    }
                  />
                  أؤكد مراجعة الرصيد المعروض{" "}
                  <bdi>
                    {amount(data.balance.currentBase, data.currency.code)}
                  </bdi>{" "}
                  حتى <bdi>{data.asOfDate}</bdi> لاعتماده.
                </label>
              )}
              <div className="form-actions">
                {canFollowUp && (
                  <Button
                    type="submit"
                    disabled={locked || statistics.isFetching}
                  >
                    تسجيل متابعة الرصيد
                  </Button>
                )}
                {canApprove && (
                  <Button
                    variant="secondary"
                    disabled={
                      locked || statistics.isFetching || !confirmApproval
                    }
                    onClick={() => void submit("approval")}
                  >
                    اعتماد الرصيد المعروض
                  </Button>
                )}
              </div>
            </form>
          )}
          <p className="muted">
            فتح الكرت لا يسجّل متابعة. الخيارات الإضافية اليدوية تبقى مستقلة ولا
            تتحول إلى سجل متابعة أو اعتماد.
          </p>
        </>
      )}
      <div className="form-actions">
        {canView && (
          <Link
            className="button button-secondary"
            to={`/companies/${companyId}/account-statistics?${reportQuery}`}
          >
            جدول إحصاءات الحسابات
          </Link>
        )}
        {canView && (
          <Button
            variant="ghost"
            disabled={statistics.isFetching || saving}
            onClick={() => void statistics.refetch()}
          >
            تحديث الإحصاءات
          </Button>
        )}
      </div>
    </Card>
  );
}
