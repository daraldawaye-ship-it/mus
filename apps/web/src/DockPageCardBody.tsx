import { Fragment } from "react";
import { Link } from "react-router-dom";
import {
  pageActions,
  pageActionLabels,
  pageReferenceHref,
  type CompanyContext,
  type PageEntry,
} from "../../../packages/contracts/src/index";
import { Notice } from "./ui";

const pageTypes: Record<PageEntry["type"], string> = {
  page: "صفحة", report: "تقرير", form: "إدخال",
};

/** Read-only details from the already authorized page directory entry. */
export function DockPageCardBody({ entry, context }: { entry: PageEntry; context?: CompanyContext }) {
  const companyId = entry.scope === "company" ? context?.company.id : undefined;
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
  </section>;
}
