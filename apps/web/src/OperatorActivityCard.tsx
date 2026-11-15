import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { operatorActivityDetailLabels } from "../../../packages/contracts/src/operator-activity";
import { pageByKey } from "../../../packages/contracts/src/pages";
import { api, useSession } from "./api";
import { Button, Card, Notice } from "./ui";

type Activity = {
  occurredAt: string; surface: string; actionKey: string; pageKey: string;
  actorId: number; actorName: string | null; employeeId: number | null; employeeName: string | null;
  companyId: number | null; detailKey: string | null; searchText: string | null;
};
const actions: Record<string,string> = {
  "avatar.open":"فتح القائمة من الصورة","navigation.open":"تبويب التنقل","item.open":"تبويب الصنف",
  "financial_account.open":"تبويب الحساب","employee.open":"تبويب المستخدم","tools.open":"تبويب أخرى",
  "settings.open":"تبويب الإعدادات","shortcut.open":"فتح اختصار","entity.open":"إجراء داخل القائمة",
  "quick_add.open":"إضافة رسالة أو مذكرة","quick_add.select":"اختيار نوع الإضافة","profile.open":"تعديل حسابي",
  "appearance.open":"المظهر","connections.open":"اتصالات ChatGPT",logout:"تسجيل الخروج",refresh:"تحديث شامل",
  "items.search":"بحث عن صنف","market.search":"بحث في السوق","lists.search":"بحث في المخزون",
};
const pages: Record<string,string> = {
  "public.home":"الرئيسية","public.companies":"الشركات","public.medicine_market":"السوق الرئيسي",
  "public.legal_cases":"القضايا","public.general_table":"الجدول العام","public.other":"صفحة عامة أخرى",
  "company.overview":"لوحة الشركة","company.accounts":"الحسابات","company.items":"الأصناف",
  "company.invoice":"الفواتير","company.attendance":"الحضور","company.inventory":"المخزون",
  "company.other":"صفحة أخرى في الشركة","public.profile":"حسابي",
};
const localTime = new Intl.DateTimeFormat("ar-YE",{timeZone:"Asia/Aden",dateStyle:"short",timeStyle:"short"});

export function OperatorActivityCard({ initiallyOpen = false }: { initiallyOpen?: boolean }) {
  const { user } = useSession();
  const [open,setOpen] = useState(initiallyOpen);
  const [days,setDays] = useState(30);
  const report=useQuery({
    queryKey:["operator-activity-report",user?.id,days], enabled:user?.owner === true && open,
    queryFn:({signal})=>api<{operatorActivity?:Activity[]}>(`/interest-events/report?days=${days}`,{signal}),
  });
  if (!user?.owner) return null;
  const rows=report.data?.operatorActivity ?? [];
  return <Card title="حركة المستخدمين" description="أحدث النقرات من قائمة الصورة والبحث المسموح. تفاصيل آخر 100 يوم، منفصلة عن سجل التدقيق.">
    <div className="page-actions">
      <Button variant="secondary" size="compact" aria-expanded={open} onClick={()=>setOpen(x=>!x)}>
        {open?"إخفاء الحركة":"عرض الحركة"}
      </Button>
      {open&&<><label>الفترة <select value={days} onChange={event=>setDays(Number(event.target.value))}>
        <option value={7}>7 أيام</option><option value={30}>30 يومًا</option><option value={100}>100 يوم</option>
      </select></label>
      <Button variant="secondary" size="compact" disabled={report.isFetching} onClick={()=>void report.refetch()}>تحديث</Button></>}
    </div>
    {open && (report.isError ? <Notice tone="error">تعذر تحميل حركة المستخدمين.</Notice> :
      report.isPending ? <Notice>جارٍ تحميل حركة المستخدمين…</Notice> :
      !rows.length ? <p>لا توجد حركات مسجلة لهذه الفترة.</p> :
      <div className="table-wrap" style={{overflowX:"auto"}}>
        <table style={{width:"100%",minWidth:620}}>
          <thead><tr>{["الوقت","المستخدم","الموظف","من أين","الزر أو البحث"].map(label=><th key={label} scope="col">{label}</th>)}</tr></thead>
          <tbody>{rows.map((activity,index)=><tr key={index}>
            <td>{localTime.format(new Date(activity.occurredAt))}</td>
            <td>{activity.actorName ?? `#${activity.actorId}`}</td>
            <td>{activity.employeeName ?? (activity.employeeId ? `#${activity.employeeId}` : "—")}</td>
            <td>{pages[activity.pageKey] ?? pageByKey(activity.pageKey)?.name ?? activity.pageKey}{
              activity.companyId ? ` · شركة ${activity.companyId}` : " · عام"}</td>
            <td>{actions[activity.actionKey] ?? activity.actionKey}{
              activity.detailKey ? `: ${operatorActivityDetailLabels[activity.detailKey] ?? pageByKey(activity.detailKey)?.name ?? activity.detailKey}` : ""}{
              activity.searchText ? `: ${activity.searchText}` : ""}</td>
          </tr>)}</tbody>
        </table>
      </div>)}
  </Card>;
}
