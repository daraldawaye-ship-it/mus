import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  normalizeDigits, type CompanyContext, type Invoice, type Page,
} from "../../../packages/contracts/src/index.ts";
import { api, useSession } from "./api";
import { isOfflineNow } from "./connection-mode";
import { formatWholeMoney } from "./format-money";
import { errorMessage } from "./phase2";
import { Button, Dialog, Field, Notice } from "./ui";
import { InvoiceListPrintJob } from "./InvoiceListPrintJob";

/** Read the last five posted sale invoices only when this sidebar view opens.
 * Uses exactly the same authorized, company-scoped invoice list as Sales.
 * Customer changes use the existing snapshot-safe PATCH (no reposting). */
export function InvoiceSideRecentSales({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const { user } = useSession();
  const queryClient = useQueryClient();
  const offline = isOfflineNow();
  const canEditCustomer = context.general || context.permissions.includes("commerce.manage");
  const queryKey = ["invoice-side-recent-sales", user?.id, companyId] as const;
  const recent = useQuery<Page<Invoice>>({
    queryKey,
    queryFn: ({ signal }) => api<Page<Invoice>>(
      "/companies/" + companyId + "/invoices?kind=sale&page=1&pageSize=5&sort=id:desc",
      { signal },
    ),
    enabled: !!user && !offline,
    staleTime: 10_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
  const [printJob, setPrintJob] = useState<{ id: number; sequence: number } | null>(null);
  const [editing, setEditing] = useState<Invoice | null>(null);
  const [customerName, setCustomerName] = useState("");
  const [customerNumber, setCustomerNumber] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [success, setSuccess] = useState("");

  const startEdit = (invoice: Invoice) => {
    if (!canEditCustomer) return;
    setEditing(invoice);
    setCustomerName(invoice.saleCustomerName ?? "");
    setCustomerNumber(invoice.saleCustomerNumber ?? "");
    setSaveError("");
    setSuccess("");
  };
  const saveCustomer = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editing || !canEditCustomer || saving) return;
    const invoice = editing;
    setSaving(true);
    setSaveError("");
    try {
      const response = await api<{ customer: {
        saleCustomerId: number | null;
        saleCustomerNumber: string | null;
        saleCustomerName: string | null;
      } }>("/companies/" + companyId + "/invoices/" + invoice.id + "/sale-customer", {
        method: "PATCH",
        body: {
          saleCustomerNumber: customerNumber.trim(),
          saleCustomerName: customerName.trim(),
          expectedSaleCustomerId: invoice.saleCustomerId,
          expectedSaleCustomerNumber: invoice.saleCustomerNumber,
          expectedSaleCustomerName: invoice.saleCustomerName,
        },
      });
      // Reflect the saved customer immediately in the sidebar before background refresh.
      queryClient.setQueryData<Page<Invoice>>(queryKey, old => old && ({
        ...old,
        items: old.items.map(row => row.id === invoice.id ? {
          ...row,
          saleCustomerId: response.customer.saleCustomerId,
          saleCustomerNumber: response.customer.saleCustomerNumber,
          saleCustomerName: response.customer.saleCustomerName,
        } : row),
      }));
      setEditing(null);
      setSuccess("تم حفظ بيانات العميل في الفاتورة " + invoice.number + ".");
      // Keep the full invoice list and printing consistent without blocking the UI.
      void queryClient.invalidateQueries({
        predicate: ({ queryKey: key }) =>
          key[0] === "list" && key[1] === user?.id &&
          String(key[2]).startsWith("company:" + companyId + ":invoices:sale"),
      });
      void queryClient.invalidateQueries({
        queryKey: ["commerce", user?.id, companyId, "invoice", invoice.id],
      });
      void recent.refetch();
    } catch (cause) {
      setSaveError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };
  const rows = recent.data?.items ?? [];

  return (
    <div className="invoice-side-recent-sales">
      {offline && <small>آخر الفواتير تحتاج إلى اتصال بالإنترنت للتحديث.</small>}
      {recent.isLoading && !offline && <small>جارٍ تحميل آخر خمس فواتير…</small>}
      {recent.isError && !offline && <small role="alert">تعذر تحميل آخر فواتير المبيعات.</small>}
      {recent.isError && !offline &&
        <Button variant="secondary" size="compact" onClick={() => { void recent.refetch(); }}>إعادة المحاولة</Button>}
      {success && <small role="status">{success}</small>}
      {rows.length > 0 ? (
        <div className="invoice-side-overview-scroll invoice-side-recent-scroll"
          role="region" aria-label="آخر خمس فواتير مبيعات" tabIndex={0}>
          <table className="invoice-side-recent-table" dir="rtl">
            <colgroup>
              <col style={{ width: "15%" }} /><col style={{ width: "20%" }} />
              <col style={{ width: "31%" }} /><col style={{ width: "34%" }} />
            </colgroup>
            <thead><tr><th scope="col">طباعة</th><th scope="col">الصافي</th>
              <th scope="col">الحساب</th><th scope="col">اسم العميل</th></tr></thead>
            <tbody>{rows.map(invoice => (
              <tr key={invoice.id}>
                <td>
                  <button type="button" className="invoice-side-recent-action"
                    aria-label={"طباعة الفاتورة " + invoice.number}
                    onClick={() => setPrintJob(previous => ({
                      id: invoice.id, sequence: (previous?.sequence ?? 0) + 1,
                    }))}>طباعة</button>
                </td>
                <td className="invoice-side-overview-amount" title={invoice.total}>
                  <bdi>{formatWholeMoney(invoice.total)}</bdi>
                </td>
                <td className="invoice-side-recent-account" title={invoice.counterpartyAccountName}>
                  {invoice.counterpartyAccountName}
                </td>
                <td>
                  {canEditCustomer ? (
                    <button type="button" className="invoice-side-recent-customer invoice-list-customer-trigger"
                      aria-label={"إضافة أو تعديل اسم ورقم عميل الفاتورة " + invoice.number}
                      title={"تعديل عميل الفاتورة " + invoice.number}
                      onClick={() => startEdit(invoice)}>
                      {invoice.saleCustomerName || "—"}
                    </button>
                  ) : <span>{invoice.saleCustomerName || "—"}</span>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : !recent.isLoading && !recent.isError && !offline ? (
        <small>لا توجد فواتير مبيعات محفوظة.</small>
      ) : null}
      {printJob && <InvoiceListPrintJob key={printJob.sequence}
        context={context} invoiceId={printJob.id} onClose={() => setPrintJob(null)} />}
      <Dialog open={editing !== null} title={"بيانات عميل الفاتورة " + (editing?.number ?? "")}
        onClose={() => { if (!saving) setEditing(null); }}>
        {editing && <form className="form-stack" onSubmit={event => void saveCustomer(event)}>
          <div className="invoice-customer-identity-row">
            <Field label="رقم العميل (اختياري)" inputMode="numeric" autoComplete="off"
              maxLength={30} value={customerNumber} autoFocus disabled={saving}
              onChange={event => setCustomerNumber(
                normalizeDigits(event.target.value).replace(/[^0-9]/g, ""),
              )} />
            <Field label="اسم العميل (اختياري)" autoComplete="off"
              maxLength={240} value={customerName} disabled={saving}
              onChange={event => setCustomerName(event.target.value)} />
          </div>
          <small className="muted">
            يمكن حفظ الاسم وحده أو الرقم وحده أو كليهما، ويمكن إفراغ الحقلين.
            لا يتغير الحساب ولا المخزون ولا إجمالي الفاتورة.
          </small>
          {saveError && <Notice tone="error">{saveError}</Notice>}
          <div className="form-actions">
            <Button type="submit" disabled={saving}>{saving ? "جارٍ الحفظ…" : "حفظ"}</Button>
            <Button type="button" variant="secondary" disabled={saving}
              onClick={() => setEditing(null)}>إلغاء</Button>
          </div>
        </form>}
      </Dialog>
    </div>
  );
}
