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
  gross: string;
  discount: string;
  invoiceGross: string;
  employeeName: string;
  notes: string;
  customerName: string;
  accountName: string;
};

function quantityText(value: string) {
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
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
  const [grossSearch, setGrossSearch] = useState("");
  const normalizedGross = normalizeDigits(grossSearch).replace(/[\s,،]/g, "");
  const validGross = normalizedGross === "" || /^-?[0-9]+(?:\.[0-9]{1,6})?$/.test(normalizedGross);
  const [filters, setFilters] = useState({ q: "", invoiceGross: "" });

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setFilters({ q: search.trim(), invoiceGross: normalizedGross });
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [search, normalizedGross]);

  const movements = useQuery<{ items: SaleItemMovement[] }>({
    queryKey: ["invoice-side-item-movements", user?.id, companyId, filters.q, filters.invoiceGross],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams();
      if (filters.q) params.set("q", filters.q);
      if (filters.invoiceGross) params.set("invoiceGross", filters.invoiceGross);
      const suffix = params.toString();
      return api<{ items: SaleItemMovement[] }>(
        "/companies/" + companyId + "/sales/line-movements" + (suffix ? "?" + suffix : ""),
        { signal },
      );
    },
    enabled: !!user && !offline && validGross,
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
        <input type="text" inputMode="decimal" value={grossSearch}
          aria-label="بحث بإجمالي مبلغ الفاتورة"
          placeholder="إجمالي الفاتورة" dir="ltr"
          onChange={event => setGrossSearch(event.target.value)}
          aria-invalid={!validGross} />
      </div>
      {!validGross && <small role="alert">أدخل مبلغ الفاتورة بالأرقام، ويمكن كتابة الكسور.</small>}
      {offline && <small>حركة الأصناف تتطلب الاتصال لتحديث البيانات.</small>}
      {!offline && validGross && movements.isLoading && <small>جارٍ تحميل آخر 10 أسطر…</small>}
      {!offline && validGross && movements.isError && (
        <div className="invoice-side-movement-error" role="alert">
          <small>تعذر تحميل حركة الأصناف. راجع الاتصال والصلاحيات.</small>
          <button type="button" onClick={() => void movements.refetch()}>إعادة المحاولة</button>
        </div>
      )}
      {validGross && (movements.data?.items.length ?? 0) > 0 && (
        <div className="invoice-side-overview-scroll invoice-side-movement-scroll"
          role="region" tabIndex={0} aria-label="آخر عشرة أسطر من حركة أصناف المبيعات">
          <table className="invoice-side-movement-table" dir="rtl">
            <colgroup>
              <col style={{ width: "18%" }} />
              <col style={{ width: "36%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "18%" }} />
              <col style={{ width: "16%" }} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">التاريخ</th>
                <th scope="col">الصنف</th>
                <th scope="col">الكمية</th>
                <th scope="col">الإجمالي</th>
                <th scope="col">الخصم</th>
              </tr>
            </thead>
            <tbody>
              {movements.data!.items.map(row => (
                <tr className="invoice-side-movement-record" key={row.id}>
                  <td colSpan={5}>
                    <table className="invoice-side-movement-inner" aria-label={"سطر صنف فاتورة " + row.invoiceNumber}>
                      <colgroup>
                        <col style={{ width: "18%" }} />
                        <col style={{ width: "36%" }} />
                        <col style={{ width: "12%" }} />
                        <col style={{ width: "18%" }} />
                        <col style={{ width: "16%" }} />
                      </colgroup>
                      <tbody>
                        <tr className="invoice-side-movement-main">
                          <td><bdi>{dayText(row.documentDate)}</bdi></td>
                          <td>{row.itemName}</td>
                          <td className="invoice-side-movement-numeric"><bdi>{quantityText(row.quantity)}</bdi></td>
                          <td className="invoice-side-movement-numeric"><bdi>{formatWholeMoney(row.invoiceGross)}</bdi></td>
                          <td className="invoice-side-movement-numeric"><bdi>{formatWholeMoney(row.discount)}</bdi></td>
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
      {!offline && validGross && !movements.isLoading && !movements.isError &&
        movements.data?.items.length === 0 && <small>لا توجد أسطر أصناف مطابقة للبحث.</small>}
    </section>
  );
}
