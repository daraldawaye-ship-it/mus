import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, useSession } from "../api";
import { Button, Card, Notice, PageHeader } from "../ui";
import "./MarketFriendReferralsPage.css";

type Referral={
  id:number;
  phone:string;
  note:string;
  category:string;
  referredBy:string;
  createdAt:string;
  cardId:number|null;
  cardName:string|null;
};
type ReferralPage={items:Referral[];total:number;page:number;pageSize:number};
const timeInYemen=(value:string)=>new Intl.DateTimeFormat("ar-YE",{
  timeZone:"Asia/Aden",
  year:"numeric",month:"2-digit",day:"2-digit",
  hour:"2-digit",minute:"2-digit",hour12:true,
}).format(new Date(value));

export function MarketFriendReferralsPage(){
  const {user}=useSession();
  const [page,setPage]=useState(1);
  const [all,setAll]=useState(!!user?.owner);
  const query=useQuery({
    queryKey:["medicine-market",user?.id,"friend-referrals",page,all],
    queryFn:({signal})=>api<ReferralPage>(
      "/medicine-market/friend-referrals?"+new URLSearchParams({
        page:String(page),...(user?.owner&&all?{all:"true"}:{}),
      }),{signal}),
    enabled:!!user,
  });
  return <main className="market-friend-records" dir="rtl">
    <PageHeader title="متابعة تعريف التطبيق للأصدقاء"
      description="سجلات تعريف الأصدقاء المحفوظة في السوق الرئيسي، دون إرسال رسائل تلقائية."
      actions={<Link className="button button-secondary" to="/medicine-market">العودة إلى السوق الرئيسي</Link>}/>
    {!user ? <Notice>سجل الدخول لاستعراض سجلاتك.</Notice>:<>
      <Card>
        <div className="market-friend-records-toolbar">
          <span>إجمالي السجلات: <strong>{query.data?.total??"—"}</strong></span>
          {user.owner&&<label>
            <input type="checkbox" checked={all}
              onChange={event=>{setAll(event.target.checked);setPage(1);}}/>
            عرض إدخالات جميع المستخدمين
          </label>}
          <Button size="compact" variant="secondary" onClick={()=>void query.refetch()}
            disabled={query.isFetching}>تحديث</Button>
        </div>
        {query.isPending&&<Notice>جارٍ تحميل السجلات…</Notice>}
        {query.error&&<Notice tone="error">
          {query.error instanceof Error?query.error.message:"تعذر تحميل السجلات"}
        </Notice>}
        <div className="market-friend-records-scroll">
          <table>
            <thead><tr>
              <th>بواسطة</th>
              <th>رقم الهاتف المستهدف</th>
              <th>بيان</th>
              <th>الفئة</th>
              <th>الوقت والتاريخ</th>
              <th>الكرت المفتوح عند الإضافة</th>
            </tr></thead>
            <tbody>{(query.data?.items??[]).map(row=><tr key={row.id}>
              <td>{row.referredBy}</td>
              <td dir="ltr" className="market-friend-phone">{row.phone}</td>
              <td className="market-friend-note">{row.note||"—"}</td>
              <td>{row.category}</td>
              <td className="market-friend-date">{timeInYemen(row.createdAt)}</td>
              <td>{row.cardId
                ? <Link to={"/medicine-market?card="+row.cardId}>{row.cardName||"#"+row.cardId}</Link>
                : "—"}</td>
            </tr>)}</tbody>
          </table>
        </div>
        {!query.isPending&&!query.error&&!query.data?.items.length&&
          <p className="muted">لا توجد إدخالات حتى الآن.</p>}
        <div className="market-friend-records-pager">
          <Button size="compact" variant="secondary" disabled={page<=1||query.isFetching}
            onClick={()=>setPage(p=>p-1)}>السابق</Button>
          <span>صفحة {page} من {Math.max(1,Math.ceil((query.data?.total??0)/(query.data?.pageSize??30)))}</span>
          <Button size="compact" variant="secondary"
            disabled={query.isFetching||page*(query.data?.pageSize??30)>=(query.data?.total??0)}
            onClick={()=>setPage(p=>p+1)}>التالي</Button>
        </div>
      </Card>
    </>}
  </main>;
}
