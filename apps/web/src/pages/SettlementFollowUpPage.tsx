import { useMemo } from "react";
import { Link } from "react-router-dom";
import type { ColumnDef } from "@tanstack/react-table";
import type { CompanyContext } from "../../../../packages/contracts/src/index";
import { usePagedQuery } from "../api";
import { formatMoney } from "../format-money";
import { Card, DataTable, Field, Notice, PageHeader } from "../ui";

interface SettlementFollowUpRow {
  id: number;
  name: string;
  monthlySales: string;
  purchasePrice: string;
  currencyCode: string;
  nearestExpiryDate: string | null;
}

export function SettlementFollowUpPage({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const list = usePagedQuery<SettlementFollowUpRow>(
    `/companies/${companyId}/settlement-follow-up`,
    `company:${companyId}:settlement-follow-up`,
    "monthlySales:desc,name:asc",
  );
  const columns = useMemo<ColumnDef<SettlementFollowUpRow, unknown>[]>(
    () => [
      {
        accessorKey: "name",
        header: "اسم الصنف",
        size: 280,
        cell: ({ row }) => (
          <Link to={`/companies/${companyId}/items/${row.original.id}`} title={row.original.name}>
            {row.original.name}
          </Link>
        ),
      },
      {
        accessorKey: "monthlySales",
        header: "المبيعات مرات في شهر",
        size: 170,
        cell: ({ row }) => (
          <bdi>{BigInt(row.original.monthlySales).toLocaleString("en-US")}</bdi>
        ),
      },
      {
        accessorKey: "purchasePrice",
        header: "سعر الشراء الافتراضي",
        size: 190,
        cell: ({ row }) => (
          <bdi>
            {formatMoney(row.original.purchasePrice)} {row.original.currencyCode}
          </bdi>
        ),
      },
      {
        accessorKey: "nearestExpiryDate",
        header: "أقرب تاريخ انتهاء",
        size: 155,
        cell: ({ row }) => <bdi>{row.original.nearestExpiryDate ?? "—"}</bdi>,
      },
    ],
    [companyId],
  );
  return (
    <>
      <PageHeader title="متابعة التسويات للأصناف" />
      <Card>
        <div className="table-filters">
          <Field
            label="بحث في الأصناف"
            type="search"
            value={list.query}
            placeholder="اسم الصنف أو الرمز أو الباركود"
            onChange={(event) => list.setQuery(event.target.value)}
          />
        </div>
        {list.error && <Notice tone="error">{list.error.message}</Notice>}
        <DataTable
          columns={columns}
          data={list.data?.items ?? []}
          total={list.data?.total ?? 0}
          page={list.page}
          pageSize={list.pageSize}
          onPageChange={list.setPage}
          onPageSizeChange={list.setPageSize}
          sorting={list.sorting}
          onSortingChange={list.setSorting}
          loading={list.loading}
          ariaLabel="متابعة التسويات للأصناف"
        />
      </Card>
    </>
  );
}
