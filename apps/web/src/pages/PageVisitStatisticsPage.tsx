import {useEffect,useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {api,useSession} from "../api";
import {Button,Card,Field,Notice,PageHeader,Select} from "../ui";

type Choice={id:number;name:string};
type Ranking={items:{pageKey:string;name:string;scope:"company"|"public";visits:string;position:number}[];total:number;page:number;pageSize:number};
type Period="all"|"30"|"90";

export function PageVisitStatisticsPage(){
  const {user,employeePreview,visitorOnly}=useSession();
  if(!user?.owner||employeePreview||visitorOnly)return <Notice tone="warning">هذه الإحصاءات للمالك فقط.</Notice>;
  return <VisitRanking key={user.id} actorId={user.id}/>;
}

function VisitRanking({actorId}:{actorId:number}){
  const [typed,setTyped]=useState("");
  const [query,setQuery]=useState("");
  const [selected,setSelected]=useState<Choice|null>(null);
  const [period,setPeriod]=useState<Period>("all");
  const [page,setPage]=useState(1);
  useEffect(()=>{
    const timer=window.setTimeout(()=>setQuery(typed.trim()),230);
    return ()=>window.clearTimeout(timer);
  },[typed]);
  const lookupActive=query.length>=2&&query===typed.trim()&&!selected;
  const matches=useQuery({
    queryKey:["owner-page-visit-users",actorId,query],
    queryFn:({signal})=>api<{items:Choice[]}>(`/page-visit-statistics/users?${new URLSearchParams({q:query})}`,{signal}),
    enabled:lookupActive,retry:false,staleTime:0,gcTime:0,
  });
  const rank=useQuery({
    queryKey:["owner-page-visit-ranking",actorId,selected?.id??null,period,page],
    queryFn:({signal})=>api<Ranking>(`/page-visit-statistics?${new URLSearchParams({
      page:String(page),period,...(selected?{userId:String(selected.id)}:{}),
    })}`,{signal}),
    retry:false,staleTime:0,gcTime:0,
  });
  const reset=()=>{setTyped("");setQuery("");setSelected(null);setPage(1);};
  const choices=lookupActive&&!matches.isError?matches.data?.items??[]:[];
  const repeats=new Map<string,number>();
  for(const choice of choices)repeats.set(choice.name,(repeats.get(choice.name)??0)+1);
  const data=rank.isError?undefined:rank.data;
  return <>
    <PageHeader title="إحصاءات زيارات الصفحات"
      description="مرتبة حسب عدد الزيارات المسجّلة، وليست عدد الأشخاص. تشمل الزيارات العامة وزيارات صفحات الشركات التي يسجّلها النظام." />
    <Card>
      <div className="form-actions">
        <Field label="البحث باسم المستخدم" type="search" maxLength={100} autoComplete="off" value={typed}
          placeholder="كل المستخدمين" onChange={event=>{
            setTyped(event.currentTarget.value);
            if(selected){setSelected(null);setPage(1);}
          }} />
        <Select label="الفترة" value={period} onChange={event=>{setPeriod(event.currentTarget.value as Period);setPage(1);}}>
          <option value="all">كل الفترة المسجّلة</option><option value="30">آخر 30 يومًا</option><option value="90">آخر 90 يومًا</option>
        </Select>
        <Button type="button" variant="secondary" size="compact" onClick={reset}>كل المستخدمين</Button>
      </div>
      {lookupActive&&<div className="form-actions" aria-label="المستخدمون المطابقون">
        {matches.isPending?<small role="status">جارٍ البحث…</small>:matches.isError?<small role="status">تعذّر البحث عن المستخدمين.</small>
          : choices.length===0?<small role="status">لا يوجد مستخدم مطابق.</small>
          : choices.map(choice=><Button key={choice.id} type="button" size="compact" variant="secondary"
              onClick={()=>{setSelected(choice);setTyped(choice.name);setPage(1);}}>
              {choice.name} {(repeats.get(choice.name)??0)>1&&<bdi>#{choice.id}</bdi>}
            </Button>)}
      </div>}
      <p className="muted">النتائج: {selected?<>{selected.name} <bdi>#{selected.id}</bdi></>:"كل المستخدمين"}</p>
    </Card>
    <Card>
      {rank.isPending?<Notice>جارٍ حساب الزيارات المسجّلة…</Notice>:rank.isError?<Notice tone="error">
        تعذّر تحميل إحصاءات الزيارات. <Button type="button" variant="ghost" onClick={()=>void rank.refetch()}>إعادة المحاولة</Button>
      </Notice>:data&&!data.items.length?<Notice>{page===1?"لا توجد زيارات مسجّلة لهذا الاختيار.":"لم تعد توجد نتائج في هذه الصفحة."}
        {page>1&&<Button type="button" variant="ghost" onClick={()=>setPage(1)}>العودة إلى الصفحة الأولى</Button>}
      </Notice>:data&&<>
        <div className="table-scroll">
          <table className="data-table" aria-label="ترتيب الصفحات حسب الزيارات">
            <thead><tr><th scope="col">الترتيب</th><th scope="col">الصفحة</th><th scope="col">النطاق</th>
              <th scope="col" aria-sort="descending">الزيارات المسجّلة</th></tr></thead>
            <tbody>{data.items.map(entry=><tr key={entry.pageKey}>
              <td><bdi>{entry.position}</bdi></td><td>{entry.name}</td>
              <td>{entry.scope==="company"?"الشركات":"الموقع العام"}</td>
              <td><bdi>{entry.visits}</bdi></td>
            </tr>)}</tbody>
          </table>
        </div>
        {data.total>data.pageSize&&<div className="form-actions" aria-label="صفحات نتائج الإحصاءات">
          <Button type="button" size="compact" variant="secondary" disabled={page===1||rank.isFetching}
            onClick={()=>setPage(n=>n-1)}>السابق</Button>
          <bdi>{page} / {Math.ceil(data.total/data.pageSize)}</bdi>
          <Button type="button" size="compact" variant="secondary" disabled={page*data.pageSize>=data.total||rank.isFetching}
            onClick={()=>setPage(n=>n+1)}>التالي</Button>
        </div>}
      </>}
    </Card>
  </>;
}
