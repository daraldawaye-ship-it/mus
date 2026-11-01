import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import type { ColumnDef } from "@tanstack/react-table";
import type { CompanyContext, Item } from "../../../../packages/contracts/src/index";
import { api, usePagedQuery } from "../api";
import { formatMoney } from "../format-money";
import { Button, Card, DataTable, Dialog, Field, Notice, PageHeader } from "../ui";
import { InventoryAdjustmentSheet } from "./InventoryPages";

interface SettlementFollowUpRow {
  id: number;
  name: string;
  monthlySales: string;
  purchasePrice: string;
  currencyCode: string;
  nearestExpiryDate: string | null;
  lastAdjustmentDate: string | null;
  countLimit: string;
}

export function SettlementFollowUpPage({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const [params, setParams] = useSearchParams();
  // Omitted filter defaults to the items that need stock-taking.
  // An explicit dueOnly=0 is the only way to see every item.
  const dueOnly = params.get("dueOnly") !== "0";
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null);
  const itemQuery = useQuery({
    queryKey: ["settlement-follow-up", companyId, "item", selectedItemId],
    queryFn: ({ signal }) => api<{ item: Item }>(
      `/companies/${companyId}/items/${selectedItemId}`, { signal },
    ),
    enabled: selectedItemId !== null,
    staleTime: 0,
  });
  const canAdjust = context.general || (
    context.permissions.includes("inventory.post") &&
    context.permissions.includes("finance.post")
  );
  const list = usePagedQuery<SettlementFollowUpRow, {
    stocktakeFrequencyTotal: string;
    stockedItemsCount: number;
  }>(
    `/companies/${companyId}/settlement-follow-up?dueOnly=${dueOnly ? "1" : "0"}`,
    `company:${companyId}:settlement-follow-up`,
    "monthlySales:desc,name:asc",
  );
  const columns = useMemo<ColumnDef<SettlementFollowUpRow, unknown>[]>(
    () => [
      {
        id: "adjustment",
        header: "تسوية",
        size: 105,
        enableSorting: false,
        cell: ({ row }) => (
          <Button variant="secondary" disabled={!canAdjust}
            title={canAdjust ? "فتح تسوية الصنف داخل نافذة" : "التسوية تتطلب صلاحية ترحيل المخزون والمالية"}
            onClick={() => setSelectedItemId(row.original.id)}>
            تسوية
          </Button>
        ),
      },
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
      {
        accessorKey: "lastAdjustmentDate",
        header: "آخر تسوية بتاريخ",
        size: 160,
        cell: ({ row }) => <bdi>{row.original.lastAdjustmentDate ?? "—"}</bdi>,
      },
      {
        accessorKey: "countLimit",
        header: "الجرد لا يزيد عن",
        size: 175,
        cell: ({ row }) => <bdi>{row.original.countLimit}</bdi>,
      },
    ],
    [companyId, canAdjust],
  );
  return (
    <>
      <PageHeader title="متابعة التسويات للأصناف" />
      <Card
        title="إجمالي الجرد خلال 30 يومًا"
        description="مجموع (30 ÷ الجرد لا يزيد عن) للأصناف ذات الرصيد الموجب فقط، وفق البحث الحالي وعبر جميع صفحات الجدول."
      >
        <p>
          <strong style={{ fontSize: "1.6rem", fontVariantNumeric: "tabular-nums" }}>
            {list.loading && !list.data
              ? "…"
              : Number(list.data?.stocktakeFrequencyTotal ?? "0").toLocaleString("en-US", {
                  maximumFractionDigits: 3,
                })}
          </strong>{" "}مرة جرد
        </p>
        <p>الأصناف ذات الكمية: {list.data?.stockedItemsCount ?? 0}</p>
      </Card>
      {selectedItemId !== null && !itemQuery.data?.item && (
        <Dialog open title="فتح تسوية الصنف" onClose={() => setSelectedItemId(null)}>
          {itemQuery.isPending && <p>جارٍ تحميل كرت الصنف…</p>}
          {itemQuery.error && <Notice tone="error">تعذر تحميل الصنف. يمكنك إغلاق النافذة وإعادة المحاولة.</Notice>}
        </Dialog>
      )}
      {selectedItemId !== null && itemQuery.data?.item && (
        <InventoryAdjustmentSheet
          key={selectedItemId}
          context={context}
          item={itemQuery.data.item}
          fromRequiredPage
          onClose={() => setSelectedItemId(null)}
          onSaved={() => { void list.refetch(); }}
        />
      )}
      <Card>
        <div className="table-filters">
          <Field
            label="بحث في الأصناف"
            type="search"
            value={list.query}
            placeholder="اسم الصنف أو الرمز أو الباركود"
            onChange={(event) => list.setQuery(event.target.value)}
          />
          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={dueOnly}
              onChange={(event) => {
                const checked = event.target.checked;
                setParams((previous) => {
                  const next = new URLSearchParams(previous);
                  if (checked) next.delete("dueOnly");
                  else next.set("dueOnly", "0");
                  next.delete("page");
                  return next;
                });
              }}
            />
            الأصناف المطلوب جردها فقط
          </label>
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
