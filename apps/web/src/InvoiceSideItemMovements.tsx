import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  normalizeDigits, type CompanyContext,
} from "../../../packages/contracts/src/index.ts";
import { api, useSession } from "./api";
import { isOfflineNow } from "./connection-mode";
import { formatWholeMoney } from "./format-money";

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

/** Latest 10 sale *lines* (not invoices), fetched only when chosen in the sales sidebar. */
export function InvoiceSideItemMovements({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const { user } = useSession();
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
      {!offline && validNet && movements.isLoading && <small>جارٍ تحميل آخر 10 أسطر…</small>}
      {!offline && validNet && movements.isError && (
        <div className="invoice-side-movement-error" role="alert">
          <small>تعذر تحميل حركة الأصناف. راجع الاتصال والصلاحيات.</small>
          <button type="button" onClick={() => void movements.refetch()}>إعادة المحاولة</button>
        </div>
      )}
      {validNet && (movements.data?.items.length ?? 0) > 0 && (
        <div className="invoice-side-overview-scroll invoice-side-movement-scroll"
          role="region" tabIndex={0} aria-label="آخر عشرة أسطر من حركة أصناف المبيعات">
          <table className="invoice-side-movement-table" dir="rtl">
            <colgroup>
              <col style={{ width: "16%" }} />
              <col style={{ width: "36%" }} />
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
                        <col style={{ width: "16%" }} />
                        <col style={{ width: "36%" }} />
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
                            <span>({row.employeeName || "—"})</span>
                            <span>({row.notes || "—"})</span>
                            <span>({row.customerName || "—"})</span>
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
    </section>
  );
}
