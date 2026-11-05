import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { Notice } from "./ui";

type ReceiptMatch = { id: number; number: string; documentDate: string };

export function PurchaseReceiptDuplicateWarning({
  companyId, supplierAccountId, receiptNumber, documentDate, excludeInvoiceId,
}: {
  companyId: number;
  supplierAccountId: number | null;
  receiptNumber: string;
  documentDate: string;
  excludeInvoiceId?: number;
}) {
  const entered = receiptNumber.trim();
  const [debounced, setDebounced] = useState(entered);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(entered), 350);
    return () => window.clearTimeout(timer);
  }, [entered]);
  const year = Number(documentDate.slice(0, 4));
  const ready = !!supplierAccountId && entered.length > 0 &&
    entered === debounced && year >= 1900 && year <= 2099;
  const lookup = useQuery({
    queryKey: ["purchase-receipt-duplicate", companyId, supplierAccountId, year, debounced, excludeInvoiceId],
    enabled: ready,
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({
        supplierAccountId: String(supplierAccountId),
        receiptNumber: debounced,
        year: String(year),
      });
      if (excludeInvoiceId) params.set("excludeInvoiceId", String(excludeInvoiceId));
      return api<{ match: ReceiptMatch | null }>(
        `/companies/${companyId}/invoices/receipt-duplicate?${params}`, { signal },
      );
    },
    staleTime: 0,
  });
  if (!ready) return null;
  if (lookup.isError) return (
    <Notice tone="warning">تعذر فحص تكرار رقم الوصل حاليًا؛ يمكنك متابعة حفظ الفاتورة.</Notice>
  );
  const duplicate = lookup.data?.match;
  if (!duplicate) return null;
  return (
    <Notice tone="warning">
      تنبيه فقط: رقم الوصل «{entered}» سبق إدخاله لهذا المورد في عام {year}، في{" "}
      <Link to={`/companies/${companyId}/invoices/${duplicate.id}`}>
        الفاتورة {duplicate.number}
      </Link>{" "}
      بتاريخ {duplicate.documentDate}. يمكنك متابعة الحفظ دون منع.
    </Notice>
  );
}
