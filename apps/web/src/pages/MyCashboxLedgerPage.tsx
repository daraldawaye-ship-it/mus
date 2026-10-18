import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
  documentKindLabels,
  type AccountLedgerLine,
  type AccountLedgerTotals,
  type CompanyContext,
  type Page,
} from "../../../../packages/contracts/src/index";
import { api, useSession } from "../api";
import { errorMessage } from "../phase2";
import { formatMoney } from "../format-money";
import { Card, DataTable, Field, Notice, PageHeader } from "../ui";

type MyCashboxLedger = Page<AccountLedgerLine> & {
  account: { id: number; code: string; name: string } | null;
  totals: AccountLedgerTotals | null;
};

const balanceText = (amount: string) =>
  amount.startsWith("-")
    ? `${formatMoney(amount.slice(1))} دائن`
    : `${formatMoney(amount)} مدين`;

export function MyCashboxLedgerPage({ context }: { context: CompanyContext }) {
  const { user } = useSession();
  const companyId = context.company.id;
  const allowed =
    context.general ||
    context.permissions.includes("finance.own-cashbox.view");
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get("page")) || 1);
  const pageSize = [10, 20, 50, 100].includes(Number(params.get("pageSize")))
    ? Number(params.get("pageSize"))
    : 20;
  const query = new URLSearchParams();
  for (const field of ["dateFrom", "dateTo"])
    if (params.get(field)) query.set(field, params.get(field)!);
  query.set("page", String(page));
  query.set("pageSize", String(pageSize));

  const result = useQuery({
    queryKey: ["finance", user?.id, companyId, "my-cashbox-ledger", query.toString()],
    queryFn: ({ signal }) =>
      api<MyCashboxLedger>(
        `/companies/${companyId}/my-cashbox-ledger?${query}`,
        { signal },
      ),
    enabled: Boolean(user && allowed),
  });
  const columns = useMemo<ColumnDef<AccountLedgerLine, unknown>[]>(
    () => [
      { accessorKey: "documentDate", header: "التاريخ", enableSorting: false },
      { accessorKey: "documentNumber", header: "المستند", enableSorting: false },
      {
        accessorKey: "kind",
        header: "النوع",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.reversesDocumentId
            ? "قيد عكسي"
            : documentKindLabels[row.original.kind],
      },
      { accessorKey: "description", header: "البيان", enableSorting: false },
      { accessorKey: "currencyCode", header: "عملة المستند", enableSorting: false },
      {
        accessorKey: "baseDebit",
        header: "مدين",
        enableSorting: false,
        cell: ({ row }) => formatMoney(row.original.baseDebit),
      },
      {
        accessorKey: "baseCredit",
        header: "دائن",
        enableSorting: false,
        cell: ({ row }) => formatMoney(row.original.baseCredit),
      },
      {
        accessorKey: "runningBalance",
        header: "الرصيد الجاري",
        enableSorting: false,
        cell: ({ row }) => <bdi>{balanceText(row.original.runningBalance)}</bdi>,
      },
    ],
    [],
  );
  const update = (field: string, value: string | null) =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (value) next.set(field, value);
      else next.delete(field);
      if (field !== "page") next.delete("page");
      return next;
    });

  if (!allowed)
    return <Notice tone="warning">لا تملك صلاحية عرض كشف حساب صندوقي.</Notice>;
  return (
    <>
      <PageHeader
        title="كشف حساب صندوقي"
        description="حركات ورصيد صندوق المبيعات المربوط بحسابك فقط، دون صلاحية الاطلاع على حسابات الآخرين."
      />
      <Card>
        <div className="table-filters">
          <Field
            label="من تاريخ"
            type="date"
            value={params.get("dateFrom") ?? ""}
            onChange={(event) => update("dateFrom", event.target.value)}
          />
          <Field
            label="إلى تاريخ"
            type="date"
            value={params.get("dateTo") ?? ""}
            onChange={(event) => update("dateTo", event.target.value)}
          />
        </div>
        {result.isLoading && <Notice>جارٍ تحميل الكشف…</Notice>}
        {result.error && <Notice tone="error">{errorMessage(result.error)}</Notice>}
        {result.data && !result.data.account && (
          <Notice>لا يوجد صندوق مبيعات فعال مربوط بحسابك في هذه الشركة.</Notice>
        )}
        {result.data?.account && (
          <>
            <div className="financial-totals">
              <strong>
                الصندوق: {result.data.account.code} — {result.data.account.name}
              </strong>
              <span>الافتتاحي: {formatMoney(result.data.totals!.openingBalance)}</span>
              <span>مدين الفترة: {formatMoney(result.data.totals!.debit)}</span>
              <span>دائن الفترة: {formatMoney(result.data.totals!.credit)}</span>
              <strong>
                الختامي: <bdi>{balanceText(result.data.totals!.closingBalance)}</bdi>{" "}
                {result.data.totals!.baseCurrencyCode}
              </strong>
            </div>
            <DataTable
              columns={columns}
              data={result.data.items}
              total={result.data.total}
              page={page}
              pageSize={pageSize}
              onPageChange={(value) => update("page", String(value))}
              onPageSizeChange={(value) => update("pageSize", String(value))}
              sorting={[]}
              onSortingChange={() => {}}
              loading={result.isFetching}
              ariaLabel="كشف حساب صندوقي"
            />
          </>
        )}
      </Card>
    </>
  );
}
