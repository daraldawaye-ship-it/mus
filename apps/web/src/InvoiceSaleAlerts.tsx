import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export type SaleAlerts = {
  saleNotes: string;
  compositionSaleNotes: string;
  compositionName: string;
  identicalAlternative: boolean;
  alternatives: {
    id: number; name: string; clearanceRate: string; nearestExpiryDate: string | null;
    clearance: boolean; nearExpiry: boolean;
  }[];
};

/** Asynchronous sidebar only: never intercept invoice keyboard navigation,
 * price calculations, onChange, or save. Cached per selected company/item. */
export function InvoiceSaleAlerts({
  companyId,userId,itemId,
}: {
  companyId:number; userId:number|undefined; itemId:number|null;
}) {
  const { data, isError }=useQuery<SaleAlerts>({
    queryKey:["sales-item-alerts",userId,companyId,itemId],
    queryFn:({signal})=>api<SaleAlerts>(`/companies/${companyId}/sales-item-alerts/${itemId}`,{signal}),
    enabled:!!userId && itemId!==null,
    staleTime:60_000,refetchOnWindowFocus:false,
  });
  if(!itemId || (!data && !isError))return null;
  if(isError)return null; // Informative-only: sale entry must not be blocked.
  if(!data)return null;
  const hasNotes=!!data.saleNotes||!!data.compositionSaleNotes;
  if(!hasNotes && !data.alternatives.length)return null;
  return (
    <section className="invoice-sale-alerts invoice-sale-alerts-inline" aria-label="تنبيهات الصنف عند البيع">
      {[
        ...[data.saleNotes,data.compositionSaleNotes].filter(Boolean).map((note,index)=>(
          <span key={`note-${index}`} className="invoice-sale-inline-note">{note}</span>
        )),
        ...data.alternatives.map(row=>(
          <span key={`peer-${row.id}`} className={row.clearance?"invoice-sale-inline-clearance":"invoice-sale-inline-peer"}
            title={row.name}>
            {row.name}{row.clearance?` (تصريف ${row.clearanceRate}%)`:""}
            {row.nearExpiry?` (انتهاء ${row.nearestExpiryDate?.slice(0,7)??"قريب"})`:""}
          </span>
        )),
      ].map((segment,index)=><span key={index} className="invoice-sale-inline-segment">
        {index>0&&<span className="invoice-sale-inline-separator"> — </span>}{segment}
      </span>)}
    </section>
  );
}
