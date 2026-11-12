import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CompanyContext } from "../../../../packages/contracts/src/index";
import { api, useSession } from "../api";
import { errorMessage } from "../phase2";
import { Button, Card, Notice, PageHeader } from "../ui";

type PublicRequestRow = {
  id: number; itemId: number; itemName: string;
  requestDate: string; createdByName: string; createdAt: string;
};
type PublicRequestList = {
  items: PublicRequestRow[]; total: number; page: number; pageSize: number;
};

export function PublicRequestsPage({context}: {context: CompanyContext}) {
  const companyId = context.company.id;
  const {user} = useSession();
  const [search,setSearch] = useState("");
  const [queryText,setQueryText] = useState("");
  const [page,setPage] = useState(1);
  const data = useQuery({
    queryKey:["public-requests",user?.id,companyId,page,queryText],
    queryFn:({signal}) => {
      const query = new URLSearchParams({page:String(page)});
      if (queryText) query.set("q",queryText);
      return api<PublicRequestList>(`/companies/${companyId}/public-requests?${query}`,{signal});
    },
    enabled:!!user,
    staleTime:10000,
  });
  const pages = Math.max(1,Math.ceil((data.data?.total ?? 0)/100));
  const dateTime = (value:string) => {
    const time = new Date(value);
    return Number.isNaN(time.getTime()) ? value : time.toLocaleString("ar-YE",{
      timeZone:"Asia/Aden",year:"numeric",month:"2-digit",day:"2-digit",
      hour:"2-digit",minute:"2-digit"
    });
  };
  return <section>
    <PageHeader title="طلب الجمهور" description="الأصناف التي طلبها الجمهور وسجّلها الموظفون." />
    <Card>
      <form onSubmit={event=>{event.preventDefault();setPage(1);setQueryText(search.trim());}}
        style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"end",marginBottom:8}}>
        <label style={{flex:"1 1 200px"}}>
          <span>بحث بالصنف أو الموظف</span>
          <input type="search" value={search} maxLength={120}
            onChange={event=>setSearch(event.target.value)} placeholder="الصنف / بواسطة" />
        </label>
        <Button type="submit" size="compact">بحث</Button>
        <Button type="button" variant="secondary" size="compact"
          onClick={()=>{setSearch("");setQueryText("");setPage(1);void data.refetch();}}>إظهار الكل</Button>
      </form>
      {data.isError && <Notice tone="error">{errorMessage(data.error)}</Notice>}
      {data.isLoading && <Notice>جارٍ تحميل طلبات الجمهور…</Notice>}
      {data.data && <>
        <div className="table-scroll" role="region" aria-label="طلبات الجمهور">
          <table className="data-table" dir="rtl">
            <thead><tr><th>الصنف</th><th>تاريخ الإضافة</th><th>بواسطة</th></tr></thead>
            <tbody>
              {data.data.items.map(row=><tr key={row.id}>
                <td dir="auto">{row.itemName}</td>
                <td title={row.requestDate}>{dateTime(row.createdAt)}</td>
                <td>{row.createdByName}</td>
              </tr>)}
            </tbody>
          </table>
        </div>
        {data.data.items.length===0 && <Notice>لا توجد طلبات جمهور مسجلة.</Notice>}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,marginTop:8,flexWrap:"wrap"}}>
          <small>الإجمالي {data.data.total} — صفحة {page} من {pages}</small>
          <div style={{display:"flex",gap:6}}>
            <Button size="compact" variant="secondary" disabled={page<=1}
              onClick={()=>setPage(x=>x-1)}>السابق</Button>
            <Button size="compact" variant="secondary" disabled={page>=pages}
              onClick={()=>setPage(x=>x+1)}>التالي</Button>
          </div>
        </div>
      </>}
    </Card>
  </section>;
}
