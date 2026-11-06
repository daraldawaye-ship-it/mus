import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  normalizeDigits, type CompanyContext, type Invoice,
} from "../../../packages/contracts/src/index.ts";
import { api, useSession } from "./api";
import { isOfflineNow } from "./connection-mode";
import { formatWholeMoney } from "./format-money";
import { errorMessage } from "./phase2";
import { Button, Dialog, Field, Notice } from "./ui";
import { InvoiceListPrintJob } from "./InvoiceListPrintJob";

type SaleItemMovement = {
  id: number;
  invoiceId: number;
  invoiceNumber: string;
  documentDate: string;
  itemName: string;
  quantity: string;
  invoiceDiscount: string;
  invoiceTotal: string;
  employeeName: string;
  notes: string;
  customerName: string;
  accountName: string;
};

function quantityText(value: string) {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return value;
  const [, sign, integer, fraction = ""] = match;
  const roundedTenths = BigInt(integer) * 10n + BigInt(fraction[0] ?? "0") +
    (Number(fraction[1] ?? "0") >= 5 ? 1n : 0n);
  const whole = roundedTenths / 10n;
  const tenth = roundedTenths % 10n;
  const result = whole.toString() + (tenth === 0n ? "" : "." + tenth.toString());
  return sign && roundedTenths !== 0n ? "-" + result : result;
}

function dayText(value: string) {
  const [year, month, day] = value.slice(0, 10).split("-");
  return year && month && day ? day + "/" + month + "/" + year : value;
}

/** Latest sale lines: 40 for all search modes. */
export function InvoiceSideItemMovements({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const { user } = useSession();
  const queryClient = useQueryClient();
  const canEditCustomer = context.general || context.permissions.includes("commerce.manage");
  const offline = isOfflineNow();
  const [search, setSearch] = useState("");
  const [netSearch, setNetSearch] = useState("");
  const normalizedNet = normalizeDigits(netSearch).replace(/[\s,،]/g, "");
  const validNet = normalizedNet === "" || /^-?[0-9]+(?:\.[0-9]{1,6})?$/.test(normalizedNet);
  const [filters, setFilters] = useState({ q: "", invoiceTotal: "" });

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setFilters({ q: search.trim(), invoiceTotal: normalizedNet });
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [search, normalizedNet]);

  const movements = useQuery<{ items: SaleItemMovement[] }>({
    queryKey: ["invoice-side-item-movements", user?.id, companyId, filters.q, filters.invoiceTotal],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams();
      if (filters.q) params.set("q", filters.q);
      if (filters.invoiceTotal) params.set("invoiceTotal", filters.invoiceTotal);
      const suffix = params.toString();
      return api<{ items: SaleItemMovement[] }>(
        "/companies/" + companyId + "/sales/line-movements" + (suffix ? "?" + suffix : ""),
        { signal },
      );
    },
    enabled: !!user && !offline && validNet,
    staleTime: 10_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });


  const [printJob, setPrintJob] = useState<{ id: number; sequence: number } | null>(null);
  const [editing, setEditing] = useState<Invoice | null>(null);
  const [customerName, setCustomerName] = useState("");
  const [customerNumber, setCustomerNumber] = useState("");
  const [openingCustomerId, setOpeningCustomerId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [customerError, setCustomerError] = useState("");
  const [customerSuccess, setCustomerSuccess] = useState("");

  async function openCustomer(invoiceId: number) {
    if (!canEditCustomer || openingCustomerId !== null) return;
    setOpeningCustomerId(invoiceId);
    setCustomerError("");
    setCustomerSuccess("");
    try {
      // Use the current invoice snapshot so concurrent customer edits remain safe.
      const { invoice } = await api<{ invoice: Invoice }>(
        "/companies/" + companyId + "/invoices/" + invoiceId,
      );
      setEditing(invoice);
      setCustomerName(invoice.saleCustomerName ?? "");
      setCustomerNumber(invoice.saleCustomerNumber ?? "");
    } catch (cause) {
      setCustomerError(errorMessage(cause));
    } finally {
      setOpeningCustomerId(null);
    }
  }

  async function saveCustomer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing || !canEditCustomer || saving) return;
    const invoice = editing;
    setSaving(true);
    setCustomerError("");
    try {
      await api("/companies/" + companyId + "/invoices/" + invoice.id + "/sale-customer", {
        method: "PATCH",
        body: {
          saleCustomerNumber: customerNumber.trim(),
          saleCustomerName: customerName.trim(),
          expectedSaleCustomerId: invoice.saleCustomerId,
          expectedSaleCustomerNumber: invoice.saleCustomerNumber,
          expectedSaleCustomerName: invoice.saleCustomerName,
        },
      });
      setEditing(null);
      setCustomerSuccess("تم حفظ عميل الفاتورة " + invoice.number + ".");
      await Promise.all([
        movements.refetch(),
        queryClient.invalidateQueries({
          queryKey: ["invoice-side-recent-sales", user?.id, companyId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["commerce", user?.id, companyId, "invoice", invoice.id],
        }),
        queryClient.invalidateQueries({
          predicate: ({ queryKey }) =>
            queryKey[0] === "list" && queryKey[1] === user?.id &&
            String(queryKey[2]).startsWith("company:" + companyId + ":invoices:sale"),
        }),
      ]);
    } catch (cause) {
      setCustomerError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="invoice-side-item-movements" aria-label="حركة الأصناف في المبيعات">
      <div className="invoice-side-movement-filters">
        <input type="search" value={search} maxLength={120}
          aria-label="بحث باسم الصنف أو العميل أو الملاحظات أو الحساب أو الموظف"
          placeholder="بحث: الصنف، العميل، الملاحظات، الحساب، الموظف"
          onChange={event => setSearch(event.target.value)} />
        <input type="text" inputMode="decimal" value={netSearch}
          aria-label="بحث بإجمالي مبلغ الفاتورة"
          placeholder="إجمالي الفاتورة بعد الخصم" dir="ltr"
          onChange={event => setNetSearch(event.target.value)}
          aria-invalid={!validNet} />
      </div>
      {!validNet && <small role="alert">أدخل مبلغ الفاتورة بالأرقام، ويمكن كتابة الكسور.</small>}
      {offline && <small>حركة الأصناف تتطلب الاتصال لتحديث البيانات.</small>}
      {customerSuccess && <small role="status">{customerSuccess}</small>}
      {customerError && !editing && <small role="alert">{customerError}</small>}
      {openingCustomerId !== null && <small>جارٍ فتح بيانات العميل…</small>}
      {!offline && validNet && movements.isLoading && <small>جارٍ تحميل آخر 40 سطرًا…</small>}
      {!offline && validNet && movements.isError && (
        <div className="invoice-side-movement-error" role="alert">
          <small>تعذر تحميل حركة الأصناف. راجع الاتصال والصلاحيات.</small>
          <button type="button" onClick={() => void movements.refetch()}>إعادة المحاولة</button>
        </div>
      )}
      {validNet && (movements.data?.items.length ?? 0) > 0 && (
        <div className="invoice-side-overview-scroll invoice-side-movement-scroll"
          role="region" tabIndex={0} aria-label="آخر أربعين سطرًا من حركة أصناف المبيعات">
          <table className="invoice-side-movement-table" dir="rtl">
            <colgroup>
              <col style={{ width: "20%" }} />
              <col style={{ width: "32%" }} />
              <col style={{ width: "10%" }} />
              <col style={{ width: "19%" }} />
              <col style={{ width: "19%" }} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">التاريخ</th>
                <th scope="col">الصنف</th>
                <th scope="col">كمية</th>
                <th scope="col">صافي</th>
                <th scope="col">الخصم</th>
              </tr>
            </thead>
            <tbody>
              {movements.data!.items.map(row => (
                <tr className="invoice-side-movement-record" key={row.id}>
                  <td colSpan={5}>
                    <table className="invoice-side-movement-inner" aria-label={"سطر صنف فاتورة " + row.invoiceNumber}>
                      <colgroup>
                        <col style={{ width: "20%" }} />
                        <col style={{ width: "32%" }} />
                        <col style={{ width: "10%" }} />
                        <col style={{ width: "19%" }} />
                        <col style={{ width: "19%" }} />
                      </colgroup>
                      <tbody>
                        <tr className="invoice-side-movement-main">
                          <td><span className="invoice-side-movement-date" title={dayText(row.documentDate)} dir="ltr">{dayText(row.documentDate)}</span></td>
                          <td><span className="invoice-side-movement-item" title={row.itemName}>{row.itemName}</span></td>
                          <td className="invoice-side-movement-numeric"><bdi>{quantityText(row.quantity)}</bdi></td>
                          <td className="invoice-side-movement-numeric"><bdi>{formatWholeMoney(row.invoiceTotal)}</bdi></td>
                          <td className="invoice-side-movement-numeric"><bdi>{formatWholeMoney(row.invoiceDiscount)}</bdi></td>
                        </tr>
                        <tr className="invoice-side-movement-secondary">
                          <td colSpan={5}>
                            <span>(<button type="button" className="invoice-side-movement-action"
                              aria-label={"طباعة الفاتورة " + row.invoiceNumber}
                              onClick={() => setPrintJob(previous => ({
                                id: row.invoiceId, sequence: (previous?.sequence ?? 0) + 1,
                              }))}>طباعة</button>)</span>
                            <span>({row.employeeName || "—"})</span>
                            <span>({row.notes || "—"})</span>
                            <span>({canEditCustomer ? <button type="button"
                              className="invoice-side-movement-action invoice-list-customer-trigger"
                              disabled={openingCustomerId !== null}
                              aria-label={"تعديل اسم ورقم عميل الفاتورة " + row.invoiceNumber}
                              title={"تعديل عميل الفاتورة " + row.invoiceNumber}
                              onClick={() => void openCustomer(row.invoiceId)}>{row.customerName || "—"}</button>
                              : row.customerName || "—"})</span>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!offline && validNet && !movements.isLoading && !movements.isError &&
        movements.data?.items.length === 0 && <small>لا توجد أسطر أصناف مطابقة للبحث.</small>}
      {printJob && <InvoiceListPrintJob key={printJob.sequence}
        context={context} invoiceId={printJob.id} onClose={() => setPrintJob(null)} />}
      <Dialog open={editing !== null}
        title={"بيانات عميل الفاتورة " + (editing?.number ?? "")}
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
          <small className="muted">يمكن حفظ الاسم وحده أو الرقم وحده أو كليهما؛ ولا تتغير الحسابات أو المخزون.</small>
          {customerError && <Notice tone="error">{customerError}</Notice>}
          <div className="form-actions">
            <Button type="submit" disabled={saving}>{saving ? "جارٍ الحفظ…" : "حفظ"}</Button>
            <Button type="button" variant="secondary" disabled={saving}
              onClick={() => setEditing(null)}>إلغاء</Button>
          </div>
        </form>}
      </Dialog>
    </section>
  );
}
