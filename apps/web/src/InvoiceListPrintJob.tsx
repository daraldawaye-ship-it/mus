import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import type { CompanyContext, Invoice } from "../../../packages/contracts/src/index.ts";
import { api, useSession } from "./api";
import { InvoicePrintSheet } from "./InvoicePrintSheet";
import { Button, Notice } from "./ui";

/** Print a posted invoice in the existing tab, using the same protected
 * receipt/letterhead as the invoice viewer. No popups, iframes or navigation. */
export function InvoiceListPrintJob({
  context, invoiceId, onClose,
}: {
  context: CompanyContext;
  invoiceId: number;
  onClose: () => void;
}) {
  const companyId = context.company.id;
  const { user } = useSession();
  const [letterheadReady, setLetterheadReady] = useState(false);
  const autoPrintStarted = useRef(false);
  const result = useQuery({
    queryKey: ["commerce", user?.id, companyId, "invoice", invoiceId],
    queryFn: ({ signal }) => api<{ invoice: Invoice }>(
      `/companies/${companyId}/invoices/${invoiceId}`, { signal },
    ),
    enabled: !!user && invoiceId > 0,
    // Refresh the posted invoice (including corrections made by another device).
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });
  const invoice = !result.isFetching && !result.error ? result.data?.invoice : undefined;

  // The detached print document is a sibling of the app root. Only the print
  // media stylesheet hides the list; on screen it never replaces the list.
  useEffect(() => {
    document.body.classList.add("invoice-list-print-active");
    return () => document.body.classList.remove("invoice-list-print-active");
  }, []);
  useEffect(() => {
    if (!invoice || !letterheadReady) return;
    window.addEventListener("afterprint", onClose);
    return () => window.removeEventListener("afterprint", onClose);
  }, [invoice, letterheadReady, onClose]);
  useEffect(() => {
    if (!invoice || !letterheadReady || autoPrintStarted.current) return;
    autoPrintStarted.current = true;
    // Give React and the image-load callback a paint turn before printing.
    const timer = window.setTimeout(() => window.print(), 75);
    return () => window.clearTimeout(timer);
  }, [invoice, letterheadReady]);

  const returning = !!invoice && invoice.lines.length > 0 &&
    invoice.lines.every(line => line.quantity.startsWith("-"));
  return (
    <>
      <div className="invoice-list-print-controls" role="status" aria-live="polite">
        {result.error ? <Notice tone="error">تعذر تحميل الفاتورة للطباعة.</Notice>
          : <span>{letterheadReady ? "الفاتورة جاهزة للطباعة." : "جارٍ تجهيز الفاتورة والترويسة للطباعة…"}</span>}
        {result.error && <Button variant="secondary" size="compact"
          onClick={() => { setLetterheadReady(false); void result.refetch(); }}>إعادة المحاولة</Button>}
        <Button variant="secondary" size="compact" disabled={!invoice || !letterheadReady}
          onClick={() => window.print()}>طباعة الآن</Button>
        <Button variant="ghost" size="compact" onClick={onClose}>إغلاق</Button>
      </div>
      {invoice && createPortal(
        <div className="commerce-print-document invoice-list-print-root" aria-hidden="true" dir="rtl">
          <InvoicePrintSheet context={context} invoice={invoice} returning={returning}
            onLetterheadReady={() => setLetterheadReady(true)} />
        </div>,
        document.body,
      )}
    </>
  );
}
