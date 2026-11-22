import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import InteractiveColumnsTable, { type InteractiveTableColumn } from "../InteractiveColumnsTable";
import type { CompanyContext, Item } from "../../../../packages/contracts/src/index";
import { api, usePagedQuery, useSession } from "../api";
import { formatMoney } from "../format-money";
import { Button, Card, Dialog, Field, Notice, PageHeader } from "../ui";
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
  const { user } = useSession();
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
  const columns = useMemo<InteractiveTableColumn<SettlementFollowUpRow>[]>(
    () => [
      {
        key: "adjustment",
        label: "تسوية",
        width: 105,
        sortable: false,
        cell: row => (
          <Button variant="secondary" disabled={!canAdjust}
            title={canAdjust ? "فتح تسوية الصنف داخل نافذة" : "التسوية تتطلب صلاحية ترحيل المخزون والمالية"}
            onClick={() => setSelectedItemId(row.id)}>
            تسوية
          </Button>
        ),
      },
      {
        key: "name",
        label: "اسم الصنف",
        width: 280,
        cell: row => (
          <span className="company-item-label" title={row.name}>
            {row.name}
          </span>
        ),
      },
      {
        key: "monthlySales",
        label: "المبيعات مرات في شهر",
        width: 170,
        cell: row => (
          <bdi>{BigInt(row.monthlySales).toLocaleString("en-US")}</bdi>
        ),
      },
      {
        key: "purchasePrice",
        label: "سعر الشراء الافتراضي",
        width: 190,
        cell: row => (
          <bdi>
            {formatMoney(row.purchasePrice)} {row.currencyCode}
          </bdi>
        ),
      },
      {
        key: "nearestExpiryDate",
        label: "أقرب تاريخ انتهاء",
        width: 155,
        cell: row => <bdi>{row.nearestExpiryDate ?? "—"}</bdi>,
      },
      {
        key: "lastAdjustmentDate",
        label: "آخر تسوية بتاريخ",
        width: 160,
        cell: row => <bdi>{row.lastAdjustmentDate ?? "—"}</bdi>,
      },
      {
        key: "countLimit",
        label: "الجرد لا يزيد عن",
        width: 175,
        cell: row => <bdi>{row.countLimit}</bdi>,
      },
    ],
    [canAdjust],
  );
  const activeSort = list.sorting[0];
  const total = list.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / list.pageSize));
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
        {list.loading && <Notice>جارٍ تحميل الأصناف…</Notice>}
        <InteractiveColumnsTable
          columns={columns} rows={list.data?.items ?? []} rowKey={row => row.id}
          visibleColumns={columns.map(column => column.key)} allowColumnVisibility
          storageKey={`alraesy:d13:settlement-follow-up:${companyId}:${user?.id ?? "guest"}`}
          sortKey={activeSort?.id} sortDirection={activeSort?.desc ? "desc" : "asc"}
          onSort={key => list.setSorting([{ id: key, desc: activeSort?.id === key ? !activeSort.desc : false }])}
          dockRowSource={row => ({ companyId, itemId: row.id, itemName: row.name })}
          ariaLabel="متابعة التسويات للأصناف" emptyMessage={list.loading ? "جارٍ التحميل…" : "لا توجد أصناف مطابقة."}
        />
        <div className="table-filters" style={{ marginTop: 8 }}>
          <label>حجم الصفحة <select value={list.pageSize} onChange={event => list.setPageSize(Number(event.target.value))}>
            {[10, 20, 50, 100].map(size => <option key={size} value={size}>{size}</option>)}
          </select></label>
          <small>إجمالي الأصناف: {total} — الصفحة {list.page} من {totalPages}</small>
          <Button type="button" size="compact" variant="secondary" disabled={list.page <= 1}
            onClick={() => list.setPage(list.page - 1)}>السابق</Button>
          <Button type="button" size="compact" variant="secondary" disabled={list.page >= totalPages}
            onClick={() => list.setPage(list.page + 1)}>التالي</Button>
        </div>
      </Card>
    </>
  );
}
