import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

/** Display commission percentages as whole numbers without trailing decimal zeros. */
function wholePercent(value: string): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(Math.round(parsed)) : value;
}

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
  companyId,userId,itemId,currentClearanceRate,unusedShortcut,onChooseClearance,disableSelection=false,
}: {
  companyId:number; userId:number|undefined; itemId:number|null; currentClearanceRate?:string|null;
  unusedShortcut?:string|null;
  /** Replaces only the currently selected, unlinked sales invoice row. */
  onChooseClearance?: (itemId:number)=>void;
  disableSelection?:boolean;
}) {
  const { data }=useQuery<SaleAlerts>({
    queryKey:["sales-item-alerts",userId,companyId,itemId],
    queryFn:({signal})=>api<SaleAlerts>(`/companies/${companyId}/sales-item-alerts/${itemId}`,{signal}),
    enabled:!!userId && itemId!==null,
    staleTime:60_000,refetchOnWindowFocus:false,networkMode:"always",
  });
  if(!itemId)return null;
  // The item card includes dated clearance rate. Display it even when
  // the optional server alerts have never been downloaded on this device.
  const hasNotes=!!data?.saleNotes||!!data?.compositionSaleNotes;
  if(!hasNotes && !data?.alternatives.length && !currentClearanceRate && !unusedShortcut)return null;
  return (
    <section className="invoice-sale-alerts invoice-sale-alerts-inline" aria-label="تنبيهات الصنف عند البيع">
      {[
        ...(unusedShortcut?.trim()?[<span key="unused-shortcut" className="invoice-sale-inline-shortcut" dir="ltr">({unusedShortcut.trim()})</span>]:[]),
        ...(currentClearanceRate?[<span key="current-clearance" className="invoice-sale-inline-clearance">تصريف {wholePercent(currentClearanceRate)}%</span>]:[]),
        ...[data?.saleNotes,data?.compositionSaleNotes].filter(Boolean).map((note,index)=>(
          <span key={`note-${index}`} className={index===0&&data?.saleNotes?"invoice-sale-inline-note invoice-sale-item-note":"invoice-sale-inline-note"}>{note}</span>
        )),
        ...(data?.alternatives??[]).map(row=>{
          const caption=<>
            {row.name}{row.clearance?` (تصريف ${wholePercent(row.clearanceRate)}%)`:""}
            {row.nearExpiry?` (انتهاء ${row.nearestExpiryDate?.slice(0,7)??"قريب"})`:""}
          </>;
          return row.clearance && onChooseClearance
            ? <button key={`peer-${row.id}`} type="button"
                className="invoice-sale-inline-clearance invoice-sale-inline-clearance-button"
                title={`استبدال الصنف الحالي بـ ${row.name} وتعيين وحدة بيعه الافتراضية`}
                aria-label={`استبدال الصنف الحالي بـ ${row.name}`}
                disabled={disableSelection}
                onClick={()=>onChooseClearance(row.id)}>{caption}</button>
            : <span key={`peer-${row.id}`}
                className={row.clearance?"invoice-sale-inline-clearance":"invoice-sale-inline-peer"}
                title={row.name}>{caption}</span>;
        }),
      ].map((segment,index)=><span key={index} className="invoice-sale-inline-segment">
        {index>0&&<span className="invoice-sale-inline-separator"> — </span>}{segment}
      </span>)}
    </section>
  );
}
