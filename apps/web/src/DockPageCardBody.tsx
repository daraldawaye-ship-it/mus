import {useQuery,useQueryClient} from "@tanstack/react-query";
import { Fragment,useState } from "react";
import { Link } from "react-router-dom";
import {
  employeePositionLabels,
  pageActions,
  pageActionLabels,
  pageReferenceHref,
  type CompanyContext,
  type PageEntry,
} from "../../../packages/contracts/src/index";
import { Button,Card,Notice } from "./ui";
import { api,useSession } from "./api";
import { errorMessage } from "./phase2";
import { PageDetails } from "./pages/PageDirectoryPage";
import { CentralResourceEditor,type CentralAccessResponse } from "./pages/CentralAccessPage";
import {useCompanyOverviewVisibility} from "./company-overview-visibility";
import { dockPageControls } from "./dock-page-control-access";

const pageTypes: Record<PageEntry["type"], string> = {
  page: "صفحة", report: "تقرير", form: "إدخال",
};

export function DockPageCardBody({entry,context,centralPage,overviewCompanyId}:{
  entry:PageEntry;context?:CompanyContext;centralPage?:PageEntry;overviewCompanyId?:number;
}) {
  const {user,employeePreview}=useSession();
  const client=useQueryClient();
  const controls=dockPageControls({entry,context,centralPage,owner:!!user?.owner,preview:!!employeePreview});
  const companyId=controls.companyId;
  const shortcutCompanyId=user?.owner&&!employeePreview&&
    context?.company.id===overviewCompanyId?overviewCompanyId:undefined;
  const {overviewControl,overviewFailure}=useCompanyOverviewVisibility(shortcutCompanyId);
  if (entry.scope === "company" && !companyId)
    return <Notice>اختر شركة لعرض هذه الصفحة.</Notice>;
  if (!entry.enabled || !entry.actionAccess.view)
    return <Notice tone="warning">{entry.enabled ? "لا تملك صلاحية عرض هذه الصفحة." : "هذه الصفحة معطلة."}</Notice>;

  const companyPath = companyId ? `/companies/${companyId}` : null;
  const entryPath = entry.href?.split(/[?#]/, 1)[0];
  if (companyPath && entryPath && entryPath !== companyPath && !entryPath.startsWith(companyPath + "/"))
    return <Notice tone="warning">الصفحة المحددة ليست في نطاق الشركة الحالية.</Notice>;

  return <section aria-label="بيانات الصفحة">
    <dl className="details-list">
      <dt>الصفحة</dt><dd>{entry.name}</dd>
      <dt>القسم</dt><dd>{entry.section}</dd>
      <dt>النطاق</dt><dd>{entry.scope === "company" ? "الشركة" : "الموقع العام"}</dd>
      <dt>النوع</dt><dd>{pageTypes[entry.type]}</dd>
      <dt>الحالة</dt><dd>مفعّلة{entry.visible ? "" : " · مخفية من القائمة"}</dd>
    </dl>
    {entry.description && <p className="muted">{entry.description}</p>}
    <dl className="details-list" aria-label="صلاحياتك الحالية">
      {pageActions.filter(action => !!entry.actions[action]).map(action =>
        <Fragment key={action}><dt>{pageActionLabels[action]}</dt>
          <dd>{entry.actionAccess[action] ? "مسموح" : "غير مأذون"}</dd></Fragment>)}
    </dl>
    {entry.record
      ? <small className="muted">تُفتح هذه الصفحة من سجل محدد.</small>
      : entry.href && <Link className="button button-secondary"
          to={pageReferenceHref({ pageKey: entry.key, companyId: companyId ?? null, recordId: null })}>
          فتح الصفحة
        </Link>}
    {entry.critical&&<Notice>هذه صفحة أساسية محمية؛ لا يمكن تغيير إظهارها في التنقل أو تفعيلها أو ترتيبها.</Notice>}
    {user&&controls.settings&&<>
      <PageDetails entry={entry} companyId={companyId} canManagePermissions={false}
        settingsOnly onUpdated={()=>{void client.invalidateQueries({queryKey:["list",user.id,"page-directory"]});}} />
      <small className="muted">إذا عطّلت الصفحة، أعد تفعيلها من «قائمة الصفحات»؛ لا تظهر الصفحات المعطلة في بحث لوح العمل.</small>
    </>}
    {shortcutCompanyId&&<Card title="الظهور في واجهة الشركة">
      <div className="form-actions">{overviewControl(entry)}</div>
      <small className="muted">يغيّر اختصار الصفحة في واجهة {context?.company.name ?? "الشركة الحالية"} فقط، ولا يغيّر صلاحياتها أو ظهورها في التنقل.</small>
      {overviewFailure&&<Notice tone="error">تعذّر تحديث ظهور الصفحة في واجهة الشركة: {overviewFailure}</Notice>}
    </Card>}
    {companyId&&user&&controls.centralRead&&<DockCentralPagePositions entry={entry}
      companyId={companyId} actorId={user.id} canEdit={controls.centralEdit} />}
  </section>;
}

function DockCentralPagePositions({entry,companyId,actorId,canEdit}:{
  entry:PageEntry;companyId:number;actorId:number;canEdit:boolean;
}){
  const client=useQueryClient();
  const [editing,setEditing]=useState(false);
  const queryKey=["central-access",actorId,companyId] as const;
  const current=useQuery({
    queryKey,
    queryFn:({signal})=>api<CentralAccessResponse>(`/companies/${companyId}/central-access`,{signal}),
    select:data=>data.resources.find(resource=>resource.kind==="page"&&resource.key===`page:${entry.key}`),
    staleTime:10_000,
  });
  const resource=current.data;
  const show=(positions:readonly (keyof typeof employeePositionLabels)[]|undefined)=>
    positions?.length?positions.map(position=>employeePositionLabels[position]).join("، "):"لا توجد صفات محددة (المالك فقط)";
  return <Card title="صلاحيات الصفحة في الشركة">
    {current.isError ? <Notice tone="error">{errorMessage(current.error)}</Notice>
      : current.isPending ? <Notice>جارٍ تحميل صفات العرض والتعديل…</Notice>
      : !resource ? <small className="muted">لا يوجد إعداد مركزي لهذا العنصر.</small>
      : <>
        {!resource.policy&&<small className="muted">لم تُحفظ صفات مركزية لهذه الصفحة.</small>}
        <dl className="details-list" aria-label="الصفات المركزية">
          <dt>العرض</dt><dd>{show(resource.policy?.viewPositions)}</dd>
          <dt>التعديل</dt><dd>{show(resource.policy?.editPositions)}</dd>
        </dl>
        {canEdit&&<>
          <Button type="button" size="compact" variant="secondary" aria-expanded={editing}
            onClick={()=>setEditing(value=>!value)}>{editing?"طي محرر الصلاحيات":"تعديل الصفات"}</Button>
          {editing&&<CentralResourceEditor key={`${companyId}:${resource.key}:${resource.policy?.revision??0}`}
            resource={resource} companyId={companyId} onSaved={()=>{
              void client.invalidateQueries({queryKey});
              void client.invalidateQueries({queryKey:["page-directory",actorId,companyId]});
              void client.invalidateQueries({queryKey:["list",actorId,"page-directory"]});
            }} />}
        </>}
      </>}
  </Card>;
}
