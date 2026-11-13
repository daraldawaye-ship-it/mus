import { useMemo,useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import type { CompanyContext } from "../../../../packages/contracts/src/index";
import type { SlipLedger,SlipMovement } from "../../../../packages/contracts/src/slip-receipts";
import { api } from "../api";
import { errorMessage } from "../phase2";
import { isOfflineNow } from "../connection-mode";
import { SlipReceiptDialog } from "../SlipReceiptDialog";
import { Button,Card,DataTable,Notice,PageHeader } from "../ui";

const dateTime=(value:string)=>new Intl.DateTimeFormat("ar-YE",{timeZone:"Asia/Aden",dateStyle:"short",timeStyle:"medium"}).format(new Date(value));
export function SlipMovementsPage({context}:{context:CompanyContext}) {
  const companyId=context.company.id;
  const [page,setPage]=useState(1),[pageSize,setPageSize]=useState(50),[open,setOpen]=useState(false);
  const cashier=context.general||!!context.employee?.positions.includes("cashier");
  const allowed=cashier&&(context.general||context.permissions.includes("finance.view"));
  const canPost=cashier&&(context.general||context.permissions.includes("finance.post"));
  const result=useQuery({queryKey:["slip-movements",companyId,page,pageSize],enabled:allowed,
    queryFn:({signal})=>api<SlipLedger>(`/companies/${companyId}/slip-movements?page=${page}&pageSize=${pageSize}`,{signal})});
  const columns=useMemo<ColumnDef<SlipMovement,unknown>[]>(()=>[
    {accessorKey:"createdAt",header:"التاريخ والوقت",enableSorting:false,cell:({row})=>dateTime(row.original.createdAt)},
    {accessorKey:"description",header:"الحركة",enableSorting:false},
    {accessorKey:"positive",header:"موجب (+)",enableSorting:false},
    {accessorKey:"negative",header:"سالب (−)",enableSorting:false},
    {accessorKey:"balance",header:"الرصيد",enableSorting:false},
    {accessorKey:"actor",header:"بواسطة",enableSorting:false},
  ],[]);
  if(!allowed)return <Notice tone="warning">متابعة القصاصات متاحة للمالك وأمين الصندوق فقط.</Notice>;
  return <>
    <PageHeader title="متابعة حركة القصاصات" actions={<Button disabled={!canPost||isOfflineNow()} onClick={()=>setOpen(true)}>استلام القصاصات</Button>}/>
    {open&&<SlipReceiptDialog companyId={companyId} onClose={()=>setOpen(false)}/>}
    {result.error&&<Notice tone="error">{errorMessage(result.error)}</Notice>}
    {result.data&&<Card><div className="slip-ledger-totals">
      <span>المرحّل: <b>{result.data.totals.transferred}</b></span>
      <span>المستلم: <b>{result.data.totals.received}</b></span>
      <span>نقص: <b className="text-error">{result.data.totals.shortage}</b></span>
      <span>زيادة: <b>{result.data.totals.surplus}</b></span>
      <span>بانتظار المطابقة: <b>{result.data.pending.total}</b> ({result.data.pending.count} ترحيلات)</span>
    </div></Card>}
    <Card><DataTable columns={columns} data={result.data?.items??[]} total={result.data?.total??0}
      page={page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={value=>{setPageSize(value);setPage(1);}}
      selectionMode="none" loading={result.isLoading} ariaLabel="حركة القصاصات"/></Card>
  </>;
}
