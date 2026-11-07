import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
  documentKindLabels,
  canOperateAdministrativeCustody,
  type AccountLedgerLine,
  type AccountLedgerTotals,
  type CompanyContext,
  type Page,
} from "../../../../packages/contracts/src/index";
import { api, useSession } from "../api";
import { errorMessage } from "../phase2";
import { formatMoney } from "../format-money";
import { CashboxVoucherModal } from "./FinancePages";
import { PageActionsDropdown } from "../SalesHeaderActionsDropdown";
import { InvoiceQuickAccountDialog } from "../InvoiceQuickAccountDialog";
import { isOfflineNow } from "../connection-mode";
import { Button, Card, DataTable, Dialog, Notice, PageHeader } from "../ui";

type MyCashboxLedger = Page<AccountLedgerLine> & {
  account: { id: number; code: string; name: string } | null;
  totals: AccountLedgerTotals | null;
};

const todayInAden = () => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Aden", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const part = (key: string) => parts.find(value => value.type === key)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
};
const balanceText = (amount: string) =>
  amount.startsWith("-")
    ? <><bdi>{formatMoney(amount.slice(1))}</bdi>{" "}<span className="text-error">دائن</span></>
    : amount === "0" ? <bdi>0</bdi>
      : <><bdi>{formatMoney(amount)}</bdi>{" "}مدين</>;

export function MyCashboxLedgerPage({ context, mode = "cashbox" }: {
  context: CompanyContext; mode?: "cashbox" | "administrativeCustody";
}) {
  const { user } = useSession();
  const client = useQueryClient();
  const companyId = context.company.id;
  const isCustody = mode === "administrativeCustody";
  const pageTitle = isCustody ? "العهدة الإدارية" : "كشف حساب صندوقي";
  const isCashier = context.general || !!context.employee?.positions.includes("cashier");
  const allowed = isCustody
    ? canOperateAdministrativeCustody(context)
    : (context.general || context.permissions.includes("finance.own-cashbox.view"));
  // Creating a voucher is an independent financial write privilege. A
  // cashier can view only their assigned box without gaining all finance.
  const canCreateVoucher = (context.general || context.permissions.includes("finance.manage")) &&
    (isCustody || isCashier);
  const canViewReceipts = context.general || context.permissions.includes("finance.view");
  const canAddAccount = (context.general ||
    (context.permissions.includes("commerce.manage") && context.permissions.includes("finance.post")))
    && !isOfflineNow();
  const [params, setParams] = useSearchParams();
  const [selectedMovement,setSelectedMovement] = useState<AccountLedgerLine|null>(null);
  const [voucherKind, setVoucherKind] = useState<"receipt" | "payment" | null>(null);
  const [quickAccountOpen, setQuickAccountOpen] = useState(false);
  const [accountNotice, setAccountNotice] = useState("");
  const today = todayInAden();
  const dateFrom = params.has("dateFrom") ? params.get("dateFrom") ?? "" : today;
  const dateTo = params.has("dateTo") ? params.get("dateTo") ?? "" : today;
  const page = Math.max(1, Number(params.get("page")) || 1);
  const pageSize = [10, 20, 50, 100].includes(Number(params.get("pageSize")))
    ? Number(params.get("pageSize"))
    : 50;
  const query = new URLSearchParams();
  query.set("dateFrom", dateFrom);
  query.set("dateTo", dateTo);
  query.set("page", String(page));
  query.set("pageSize", String(pageSize));

  const result = useQuery({
    queryKey: ["finance", user?.id, companyId, isCustody ? "administrative-custody-ledger" : "my-cashbox-ledger", query.toString()],
    queryFn: ({ signal }) =>
      api<MyCashboxLedger>(
        `/companies/${companyId}/${isCustody ? "administrative-custody-ledger" : "my-cashbox-ledger"}?${query}`,
        { signal },
      ),
    enabled: Boolean(user && allowed),
  });
  const columns = useMemo<ColumnDef<AccountLedgerLine, unknown>[]>(() => [
    {
      accessorKey: "runningBalance", header: "الرصيد", enableSorting: false,
      cell: ({ row }) => <span>{balanceText(row.original.runningBalance)}</span>,
    },
    {
      accessorKey: "baseDebit", header: "مدين", enableSorting: false,
      cell: ({ row }) => <bdi>{formatMoney(row.original.baseDebit)}</bdi>,
    },
    {
      accessorKey: "baseCredit", header: "دائن", enableSorting: false,
      cell: ({ row }) => <bdi>{formatMoney(row.original.baseCredit)}</bdi>,
    },
    {
      accessorKey: "counterpartAccounts", header: "الحساب المقابل", enableSorting: false,
      cell: ({ row }) => <span>{row.original.counterpartAccounts || "—"}</span>,
    },
    { accessorKey: "description", header: "البيان", enableSorting: false },
    {
      accessorKey: "kind", header: "النوع", enableSorting: false,
      cell: ({ row }) => row.original.reversesDocumentId
        ? "قيد عكسي" : documentKindLabels[row.original.kind],
    },
    { accessorKey: "documentDate", header: "التاريخ", enableSorting: false },
    { accessorKey: "documentNumber", header: "المستند", enableSorting: false },
    { accessorKey: "currencyCode", header: "العملة", enableSorting: false },
  ], []);
  const update = (field: string, value: string | null) =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      // Clearing a date explicitly means no bound, not a reset to today.
      if (field === "dateFrom" || field === "dateTo") next.set(field, value ?? "");
      else if (value) next.set(field, value);
      else next.delete(field);
      if (field !== "page") next.delete("page");
      return next;
    });

  if (!allowed)
    return <Notice tone="warning">لا تملك صلاحية عرض {pageTitle}.</Notice>;
  return (
    <>
      <div className="my-cashbox-page-heading">
        <PageHeader
          title={pageTitle}
          actions={<PageActionsDropdown actions={[
            {
              label: "إضافة حساب",
              disabled: !canAddAccount,
              onClick: () => setQuickAccountOpen(true),
            },
            {
              label: "إضافة سند صرف",
              onClick: () => setVoucherKind("payment"),
              disabled: !canCreateVoucher || !result.data?.account,
            },
            {
              label: "إضافة سند قبض",
              onClick: () => setVoucherKind("receipt"),
              disabled: !canCreateVoucher || !result.data?.account,
            },
            {
              label: "طباعة التقرير",
              onClick: () => window.print(),
            },
            ...(!isCustody ? [{
              label: "فتح استلام الترحيلات",
              to: `/companies/${companyId}/pouch-receipts`,
              disabled: !canViewReceipts,
            },
            {
              label: "فتح استلام المحفظة الإلكترونية",
              to: `/companies/${companyId}/electronic-receipts`,
              disabled: !canViewReceipts,
            }] : []),
          ]} label="إجراءات" />}
        />
      </div>
      {accountNotice && <Notice tone="success">{accountNotice}</Notice>}
      <Card className="my-cashbox-ledger-card">
        <div className="my-cashbox-date-range" role="group" aria-label={`فترة ${pageTitle}`}>
          <label className="my-cashbox-date-field">
            <span>من</span>
            <input type="date" dir="ltr" aria-label="من تاريخ"
              value={dateFrom}
              onChange={(event) => update("dateFrom", event.target.value)} />
          </label>
          <label className="my-cashbox-date-field">
            <span>إلى</span>
            <input type="date" dir="ltr" aria-label="إلى تاريخ"
              value={dateTo}
              onChange={(event) => update("dateTo", event.target.value)} />
          </label>
        </div>
        {result.isLoading && <Notice>جارٍ تحميل الكشف…</Notice>}
        {result.error && <Notice tone="error">{errorMessage(result.error)}</Notice>}
        {result.data && !result.data.account && (
          <Notice>{isCustody ? "لم يتم ربط حساب العهدة الإدارية في الحسابات النظامية." : "لا يوجد صندوق مبيعات فعال مربوط بحسابك في هذه الشركة."}</Notice>
        )}
        {result.data?.account && (
          <>
            <div className="financial-totals">
              <strong>
                {isCustody ? "العهدة" : "الصندوق"}: {result.data.account.code} — {result.data.account.name}
              </strong>
              <span>الافتتاحي: {formatMoney(result.data.totals!.openingBalance)}</span>
              <span>مدين الفترة: {formatMoney(result.data.totals!.debit)}</span>
              <span>دائن الفترة: {formatMoney(result.data.totals!.credit)}</span>
              <div className="my-cashbox-closing" aria-label={`الرصيد الختامي ${isCustody ? "للعهدة" : "للصندوق"}`}>
                <span className="my-cashbox-closing-label">الرصيد الختامي</span>
                <strong className="my-cashbox-closing-value" dir="rtl">
                  {balanceText(result.data.totals!.closingBalance)}
                  <small>{result.data.totals!.baseCurrencyCode}</small>
                </strong>
              </div>
            </div>
            {/* Phone layout: exactly two horizontal lines per movement.
                Document number and currency do not appear in this view. */}
            <div className="my-cashbox-mobile-list" role="list"
              aria-label={`حركات ${pageTitle}`}>
              {result.data.items.length===0&&
                <p className="my-cashbox-mobile-empty">لا توجد حركات في الفترة المحددة.</p>}
              {result.data.items.map(line=><article key={line.id}
                className="my-cashbox-mobile-entry" role="listitem">
                <div className="my-cashbox-mobile-first">
                  <span className="my-cashbox-mobile-balance">
                    <small>الرصيد</small>
                    <strong>{balanceText(line.runningBalance)}</strong>
                  </span>
                  <span className="my-cashbox-mobile-debit">
                    <small>مدين</small>
                    <bdi>{formatMoney(line.baseDebit)}</bdi>
                  </span>
                  <span className="my-cashbox-mobile-credit">
                    <small>دائن</small>
                    <bdi>{formatMoney(line.baseCredit)}</bdi>
                  </span>
                </div>
                <div className="my-cashbox-mobile-second">
                  <span className="my-cashbox-mobile-date" dir="ltr">{line.documentDate}</span>
                  <span className="my-cashbox-mobile-kind">
                    {line.reversesDocumentId ? "قيد عكسي" : documentKindLabels[line.kind]}
                  </span>
                  <button type="button" className="my-cashbox-mobile-summary"
                    title={`${line.counterpartAccounts||"—"} — ${line.description||"—"}`}
                    aria-label={`عرض تفاصيل حركة ${line.documentDate}`}
                    onClick={()=>setSelectedMovement(line)}>
                    {line.counterpartAccounts||"—"}{line.description&&` — ${line.description}`}
                  </button>
                </div>
              </article>)}
              {result.data.total>pageSize&&<div className="my-cashbox-mobile-pages">
                <Button variant="secondary" size="compact" disabled={page<=1||result.isFetching}
                  onClick={()=>update("page",String(page-1))}>السابق</Button>
                <span>صفحة {page} من {Math.ceil(result.data.total/pageSize)}</span>
                <Button variant="secondary" size="compact"
                  disabled={page*pageSize>=result.data.total||result.isFetching}
                  onClick={()=>update("page",String(page+1))}>التالي</Button>
              </div>}
            </div>
            <div className="my-cashbox-desktop-table">
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
              ariaLabel={pageTitle}
              />
            </div>
          </>
        )}
      </Card>
      {quickAccountOpen && <InvoiceQuickAccountDialog
        companyId={companyId}
        kind="sale"
        onClose={() => setQuickAccountOpen(false)}
        onCreated={account => {
          setQuickAccountOpen(false);
          setAccountNotice(`تم إضافة الحساب ${account.name} برمز ${account.code}.`);
          void client.invalidateQueries({queryKey:["master",user?.id,companyId]});
        }}
      />}
      {voucherKind && result.data?.account && (
        <CashboxVoucherModal key={voucherKind}
          context={context}
          kind={voucherKind}
          account={result.data.account}
          onClose={() => setVoucherKind(null)}
        />
      )}
      <Dialog open={selectedMovement!==null}
        onClose={()=>setSelectedMovement(null)} title={`تفاصيل حركة ${isCustody ? "العهدة" : "الصندوق"}`}>
        {selectedMovement&&<div className="my-cashbox-mobile-details">
          <p><strong>التاريخ:</strong> {selectedMovement.documentDate}</p>
          <p><strong>النوع:</strong> {selectedMovement.reversesDocumentId
            ? "قيد عكسي":documentKindLabels[selectedMovement.kind]}</p>
          <p><strong>الحساب المقابل:</strong> {selectedMovement.counterpartAccounts||"—"}</p>
          <p><strong>البيان:</strong> {selectedMovement.description||"—"}</p>
          <p><strong>مدين:</strong> {formatMoney(selectedMovement.baseDebit)}</p>
          <p><strong>دائن:</strong> {formatMoney(selectedMovement.baseCredit)}</p>
          <p><strong>الرصيد:</strong> {balanceText(selectedMovement.runningBalance)}</p>
        </div>}
      </Dialog>
    </>
  );
}
