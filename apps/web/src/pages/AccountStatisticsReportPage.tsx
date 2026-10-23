import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import {
  accountCategories,
  accountCategoryLabels,
  accountChoices,
  accountChoiceLabels,
  accountStatisticsMetricDefinitions,
  accountStatisticsReportGroupLabels,
  type Account,
  type AccountStatisticsReport,
  type AccountStatisticsReportCell,
  type AccountStatisticsReportGroup,
  type CompanyContext,
} from "../../../../packages/contracts/src/index.ts";
import { api, useSession } from "../api";
import { usePageDirectory } from "../page-directory";
import { errorMessage } from "../phase2";
import { formatMoney } from "../format-money";
import { rememberRecentEntity } from "../recent-entities";
import {
  AccountStatisticsCard,
  usePendingAccountStatisticsActions,
} from "../AccountStatisticsCard";
import {
  Button,
  Card,
  DataTable,
  Dialog,
  Field,
  Notice,
  PageHeader,
  Select,
  ValueCell,
} from "../ui";

const periods = {
  currentMonth: "الشهر الحالي",
  previousMonth: "الشهر السابق",
  twoMonthsAgo: "الشهر قبل السابق",
  last30Days: "آخر 30 يومًا",
  last7Days: "آخر 7 أيام",
  currentWeek: "الأسبوع الحالي",
} as const;
type Row = AccountStatisticsReport["rows"][number];
function display(
  cell: AccountStatisticsReportCell | undefined,
  kind: string,
): string {
  if (!cell || cell.value === null)
    return cell?.unavailableReason === "restricted"
      ? "غير متاح"
      : cell?.unavailableReason === "unknown"
        ? "غير محدد"
        : "—";
  if (kind === "money")
    return `${formatMoney(cell.value)} ${cell.currencyCode ?? ""}`.trim();
  if (kind === "count") return BigInt(cell.value).toLocaleString("en-US");
  if (kind === "datetime")
    return new Intl.DateTimeFormat("ar", {
      timeZone: "Asia/Aden",
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(cell.value));
  return cell.value;
}

export function AccountStatisticsReportPage({
  context,
}: {
  context: CompanyContext;
}) {
  const companyId = context.company.id,
    { user } = useSession();
  const [params, setParams] = useSearchParams();
  const directory = usePageDirectory(companyId);
  const pendingAccountIds = usePendingAccountStatisticsActions(companyId);
  const canView = !!directory.data?.find(
    (entry) => entry.key === "company.account-statistics",
  )?.actionAccess.view;
  const group = Object.hasOwn(
    accountStatisticsReportGroupLabels,
    params.get("group") ?? "",
  )
    ? (params.get("group") as AccountStatisticsReportGroup)
    : "balances";
  const period = Object.hasOwn(periods, params.get("period") ?? "")
    ? (params.get("period") as keyof typeof periods)
    : "currentMonth";
  const metricDefinitions = accountStatisticsMetricDefinitions.filter(
    (metric) =>
      metric.group === group &&
      (group !== "periods" || metric.period === period),
  );
  const q = params.get("q") ?? "";
  const [search, setSearch] = useState(q);
  useEffect(() => setSearch(q), [q, companyId, user?.id]);
  const page = Math.max(1, Number(params.get("page")) || 1);
  const pageSize = [10, 20, 50, 100].includes(Number(params.get("pageSize")))
    ? Number(params.get("pageSize"))
    : 20;
  const sort = params.get("sort") ?? "code:asc";
  const sorting: SortingState = sort
    .split(",")
    .filter(Boolean)
    .map((part) => {
      const [id = "code", direction] = part.split(":");
      return { id, desc: direction === "desc" };
    });
  const request = new URLSearchParams({
    q,
    page: String(page),
    pageSize: String(pageSize),
    sort,
    metrics: metricDefinitions.map((definition) => definition.key).join(","),
    active: params.get("active") ?? "active",
    category: params.get("category") ?? "all",
    accountChoice: params.get("accountChoice") ?? "all",
  });
  if (params.get("asOfDate")) request.set("asOfDate", params.get("asOfDate")!);
  const report = useQuery({
    queryKey: [
      "account-statistics-report",
      user?.id,
      companyId,
      request.toString(),
    ],
    queryFn: ({ signal }) =>
      api<{ report: AccountStatisticsReport }>(
        `/companies/${companyId}/account-statistics-report?${request}`,
        { signal },
      ),
    enabled: !!user && canView,
    staleTime: 0,
  });
  const result = canView && !report.error ? report.data?.report : undefined;
  const accountId = params.get("accountId");
  const validAccountId =
    !!accountId &&
    /^[1-9]\d*$/.test(accountId) &&
    Number(accountId) <= 2_147_483_647;
  const recoverPending =
    validAccountId && pendingAccountIds.includes(Number(accountId));
  const account = useQuery({
    queryKey: [
      "account-statistics-report-account",
      user?.id,
      companyId,
      accountId,
    ],
    queryFn: ({ signal }) =>
      api<{ account: Account }>(
        `/companies/${companyId}/accounts/${accountId}`,
        { signal },
      ),
    enabled: canView && validAccountId,
  });
  const change = (key: string, value: string, resetSort = false) =>
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      value ? next.set(key, value) : next.delete(key);
      if (key !== "page" && key !== "accountId") next.delete("page");
      if (resetSort) next.delete("sort");
      return next;
    });
  const columns = useMemo<ColumnDef<Row, unknown>[]>(
    () => [
      {
        id: "code",
        header: "كود الحساب",
        accessorFn: (row) => row.account.code,
        cell: ({ row }) => (
          <ValueCell>
            <bdi>{row.original.account.code}</bdi>
          </ValueCell>
        ),
      },
      {
        id: "name",
        header: "الحساب",
        accessorFn: (row) => row.account.name,
        cell: ({ row }) => (
          <ValueCell>
            {row.original.account.name}
            {!row.original.account.active && " (موقف)"}
          </ValueCell>
        ),
      },
      ...metricDefinitions.map(
        (definition) =>
          ({
            id: definition.key,
            header: definition.label,
            accessorFn: (row: Row) => row.values[definition.key]?.value,
            enableSorting:
              result?.metrics.find((metric) => metric.key === definition.key)
                ?.available ?? false,
            cell: ({ row }: { row: { original: Row } }) => {
              const value = row.original.values[definition.key];
              const text = display(value, definition.kind);
              const detail =
                definition.source === "lastAmount" &&
                value?.baseAmount !== null &&
                value?.baseAmount !== undefined
                  ? `بالعملة الأساسية: ${formatMoney(value.baseAmount)} ${value.baseCurrencyCode ?? ""}`
                  : value?.unavailableReason === "unknown"
                    ? "تصنيف المشتريات النقدية غير مكتمل في التاريخ المسجل"
                    : text;
              return (
                <ValueCell value={detail}>
                  <span title={detail}>
                    <bdi>{text}</bdi>
                  </span>
                </ValueCell>
              );
            },
          }) satisfies ColumnDef<Row, unknown>,
      ),
      {
        id: "actions",
        header: "الكرت",
        enableSorting: false,
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="compact"
            aria-label={`إحصاءات الحساب ${row.original.account.code}`}
            onClick={() => change("accountId", String(row.original.account.id))}
          >
            عرض الكرت
          </Button>
        ),
      },
    ],
    [companyId, group, period, result?.metrics],
  );
  return (
    <div className="wallet-page">
      <PageHeader
        title="إحصاءات الحسابات"
        description="الأرصدة والحركات وقيمة الأصناف للحسابات الحركية، حسب الصلاحيات الحالية."
        actions={
          <>
            <Link
              className="button button-secondary"
              to={`/companies/${companyId}/accounts`}
            >
              دليل الحسابات
            </Link>
            <Button
              variant="secondary"
              disabled={!canView || report.isFetching}
              onClick={() => void report.refetch()}
            >
              تحديث التقرير
            </Button>
          </>
        }
      />
      {directory.isPending && <Notice>جارٍ التحقق من صلاحيات التقرير…</Notice>}
      {directory.error && (
        <Notice tone="error">{errorMessage(directory.error)}</Notice>
      )}
      {!directory.isPending && !directory.error && !canView && (
        <Notice tone="warning">
          يتطلب التقرير عرض الحسابات وكشف الحساب وإحصاءاته.
        </Notice>
      )}
      <Card title="البحث والتصفية">
        <div className="form-grid">
          <form
            className="form-actions"
            onSubmit={(event) => {
              event.preventDefault();
              change("q", search.trim());
            }}
          >
            <Field
              label="بحث في الحسابات"
              type="search"
              value={search}
              maxLength={120}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="اسم الحساب أو الكود"
            />
            <Button type="submit">بحث</Button>
          </form>
          <Select
            label="مجموعة الإحصاءات"
            value={group}
            onChange={(event) => change("group", event.target.value, true)}
          >
            {Object.entries(accountStatisticsReportGroupLabels).map(
              ([key, label]) => (
                <option value={key} key={key}>
                  {label}
                </option>
              ),
            )}
          </Select>
          {group === "periods" && (
            <Select
              label="الفترة"
              value={period}
              onChange={(event) => change("period", event.target.value, true)}
            >
              {Object.entries(periods).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </Select>
          )}
          <Field
            label="تاريخ التقرير"
            type="date"
            value={params.get("asOfDate") ?? result?.asOfDate ?? ""}
            onChange={(event) => change("asOfDate", event.target.value)}
          />
          <Select
            label="حالة الحساب"
            value={params.get("active") ?? "active"}
            onChange={(event) => change("active", event.target.value)}
          >
            <option value="active">الحسابات الفعالة</option>
            <option value="all">جميع الحسابات</option>
            <option value="archived">الحسابات الموقفة</option>
          </Select>
          <Select
            label="تصنيف الحساب"
            value={params.get("category") ?? "all"}
            onChange={(event) => change("category", event.target.value)}
          >
            <option value="all">جميع التصنيفات</option>
            {accountCategories.map((category) => (
              <option value={category} key={category}>
                {accountCategoryLabels[category]}
              </option>
            ))}
          </Select>
          <Select
            label="خيار الحساب"
            value={params.get("accountChoice") ?? "all"}
            onChange={(event) => change("accountChoice", event.target.value)}
          >
            <option value="all">جميع الخيارات</option>
            <option value="unset">دون خيار</option>
            {accountChoices.map((choice) => (
              <option value={choice} key={choice}>
                {accountChoiceLabels[choice]}
              </option>
            ))}
          </Select>
        </div>
      </Card>
      {report.error && canView && (
        <Notice tone="error">
          {errorMessage(report.error)}{" "}
          <Button variant="ghost" onClick={() => void report.refetch()}>
            إعادة المحاولة
          </Button>
        </Notice>
      )}
      <Card title={accountStatisticsReportGroupLabels[group]}>
        {result && (
          <p className="muted">
            حتى <bdi>{result.asOfDate}</bdi> · العملة الأساسية{" "}
            <bdi>{result.currency.code}</bdi> ·{" "}
            {result.total.toLocaleString("ar")} حسابًا. الأسبوع يبدأ السبت.
            القيم من التاريخ المسجل.
          </p>
        )}
        {group === "balances" && (
          <p className="muted">
            المتابعة وآخر اعتماد هما أحدث سجل بشري؛ لا يحدهما تاريخ التقرير.
            الرصيد الموجب مدين والسالب دائن.
          </p>
        )}
        {group === "latestAmounts" && (
          <p className="muted">
            المبلغ بعملة المستند، والفرز بمقابله في العملة الأساسية؛ يمكن فتح
            القيمة الكاملة لقراءة المقابل.
          </p>
        )}
        {group === "stock" && (
          <p className="muted">
            القيمة حسب المورد الحالي في كرت الصنف، وحالة المخزون الحالية بتاريخ{" "}
            <bdi>{result?.currentStockDate ?? "—"}</bdi>؛ تشمل الحركات المرحلة
            حتى لو كان تاريخها مستقبليًا. الكرت يوضح الإسناد المستنتج والعجز.
          </p>
        )}
        <p className="muted">
          انقر الرأس للترتيب، ومع Shift حتى خمسة أعمدة. «غير متاح» تعني أن
          الصلاحية تحجب المؤشر.
        </p>
        <DataTable<Row>
          columns={columns}
          data={result?.rows ?? []}
          total={result?.total ?? 0}
          page={page}
          pageSize={pageSize}
          onPageChange={(value) => change("page", String(value))}
          onPageSizeChange={(value) => change("pageSize", String(value))}
          sorting={sorting}
          onSortingChange={(updater) => {
            const next = (
              typeof updater === "function" ? updater(sorting) : updater
            ).slice(0, 5);
            change(
              "sort",
              next
                .map((item) => `${item.id}:${item.desc ? "desc" : "asc"}`)
                .join(",") || "code:asc",
            );
          }}
          loading={canView && report.isFetching}
          getRowId={(row) => String(row.account.id)}
          ariaLabel="إحصاءات الحسابات"
          onRowInteract={(row: Row) => {
            if (user) rememberRecentEntity(user.id, companyId, "account",
              {id:row.account.id,name:row.account.name});
          }}
        />
      </Card>
      {(canView || recoverPending) && accountId && (
        <Dialog
          open
          title="إحصاءات الحساب"
          onClose={() => change("accountId", "")}
        >
          {!validAccountId && (
            <Notice tone="error">معرف الحساب غير صالح.</Notice>
          )}
          {validAccountId && account.isPending && (
            <Notice>جارٍ تحميل الحساب…</Notice>
          )}
          {account.error && (
            <Notice tone="error">{errorMessage(account.error)}</Notice>
          )}
          {canView && !account.error && account.data && (
            <AccountStatisticsCard
              key={`${user?.id}:${companyId}:${account.data.account.id}`}
              companyId={companyId}
              account={account.data.account}
              asOfDate={params.get("asOfDate") ?? undefined}
              onChanged={() => void report.refetch()}
            />
          )}
          {!canView && recoverPending && (
            <AccountStatisticsCard
              key={`${user?.id}:${companyId}:${accountId}:pending`}
              companyId={companyId}
              account={{
                id: Number(accountId),
                code: "",
                name: "طلب سابق بانتظار التأكيد",
                kind: "posting",
              }}
              asOfDate={params.get("asOfDate") ?? undefined}
            />
          )}
        </Dialog>
      )}
    </div>
  );
}
