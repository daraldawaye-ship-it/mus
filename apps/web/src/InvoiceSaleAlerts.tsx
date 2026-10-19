import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export type SaleAlerts = {
  saleNotes: string;
  compositionSaleNotes: string;
  compositionName: string;
  identicalAlternative: boolean;
  alternatives: {
    id: number; name: string; nearestExpiryDate: string | null;
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
    <section className="invoice-sale-alerts" aria-label="تنبيهات الصنف عند البيع">
      {data.saleNotes && <p className="invoice-sale-alert-note"><strong>ملاحظات الصنف عند البيع</strong>
        <span>{data.saleNotes}</span></p>}
      {data.compositionSaleNotes && <p className="invoice-sale-alert-note">
        <strong>ملاحظات التركيب عند البيع{data.compositionName?" — "+data.compositionName:""}</strong>
        <span>{data.compositionSaleNotes}</span>
      </p>}
      {data.alternatives.length>0 && <>
        <div className="invoice-sale-alert-peers">
          {data.alternatives.map(row=><div key={row.id} className="invoice-sale-alert-peer">
            <span className="invoice-sale-alert-item-name" title={row.name}>{row.name}</span>
            <span className="invoice-sale-alert-indicators">
              {row.clearance && <span className="invoice-sale-clearance">تصريف</span>}
              {row.nearExpiry && <span className="invoice-sale-expiry" title={row.nearestExpiryDate??""}>
                {row.nearestExpiryDate? `انتهاء ${row.nearestExpiryDate.slice(0,7)}`:"قرب انتهاء"}
              </span>}
            </span>
          </div>)}
        </div>
      </>}
    </section>
  );
}
