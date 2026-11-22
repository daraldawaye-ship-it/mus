import { ItemReserveQuickEdit } from "./ItemReserveQuickEdit";
import { ItemPurchaseFactorQuickEdit } from "./ItemPurchaseFactorQuickEdit";
import { ItemReviewedQuickEdit } from "./ItemReviewedQuickEdit";
import { ItemMinOrderQuantityQuickEdit } from "./ItemMinOrderQuantityQuickEdit";
import { ItemSpecialOrderQuantityQuickEdit, ItemOrderStopQuickActions } from "./ItemSpecialOrderQuickActions";

export type PlanningInfo = {
  revision: number; reviewed: boolean; reserveQuantity: string; purchaseFactor: number;
  minOrderQuantity: string; orderAlertQuantity: string | null; orderStoppedUntil: string | null;
};

export function OrderPlanningFields({ companyId, itemId, itemName, info, canEdit, includeThreeDayStop = false }: {
  companyId: number; itemId: number; itemName: string; info?: PlanningInfo; canEdit: boolean; includeThreeDayStop?: boolean;
}) {
  return (
    <div className="item-order-draft-extra-fields">
      <div className="item-order-draft-extra-field">
        {info ? <ItemReviewedQuickEdit companyId={companyId}
          itemId={itemId} revision={info.revision}
          reviewed={info.reviewed} canEdit={canEdit} />
          : <small>جارٍ تحميل حالة المراجعة…</small>}
      </div>
      <div className="item-order-draft-extra-field">
        <strong>كمية الاحتياط</strong>
        {info ? <ItemReserveQuickEdit companyId={companyId}
          itemId={itemId} revision={info.revision}
          reserveQuantity={info.reserveQuantity} canEdit={canEdit} />
          : <small>جارٍ تحميل بيانات الصنف…</small>}
      </div>
      <div className="item-order-draft-extra-field">
        <strong>عامل وحدة الشراء</strong>
        {info ? <ItemPurchaseFactorQuickEdit companyId={companyId}
          itemId={itemId} revision={info.revision}
          purchaseFactor={info.purchaseFactor} canEdit={canEdit} />
          : <small>جارٍ تحميل بيانات الصنف…</small>}
      </div>
      <div className="item-order-draft-extra-field">
        <strong>أقل كمية طلب</strong>
        {info ? <ItemMinOrderQuantityQuickEdit companyId={companyId}
          itemId={itemId} revision={info.revision}
          minOrderQuantity={info.minOrderQuantity} canEdit={canEdit} />
          : <small>جارٍ تحميل بيانات الصنف…</small>}
        <small className="muted">حد أدنى للكمية المحسوبة تلقائيًا فقط، ولا يغيّر الكمية المحددة يدويًا في المسودة.</small>
      </div>
      <div className="item-order-draft-extra-field">
        <strong>كمية طلب الأصناف الخاصة</strong>
        {info ? <ItemSpecialOrderQuantityQuickEdit companyId={companyId}
          itemId={itemId} revision={info.revision}
          orderAlertQuantity={info.orderAlertQuantity} canEdit={canEdit} />
          : <small>جارٍ تحميل بيانات الصنف…</small>}
        <small className="muted">التذكير يعمل حتى لو كان الصنف موقوف الطلب؛ إخلاء الحقل فقط يوقف الإشعار.</small>
      </div>
      <div className="item-order-draft-extra-field item-order-draft-stop-field">
        <strong>إيقاف طلب الصنف</strong>
        {info ? <ItemOrderStopQuickActions companyId={companyId}
          itemId={itemId} itemName={itemName} revision={info.revision}
          orderStoppedUntil={info.orderStoppedUntil} canEdit={canEdit}
          includeThreeDays={includeThreeDayStop} />
          : <small>جارٍ تحميل بيانات الصنف…</small>}
      </div>
      {!canEdit && <small className="muted">
        هذه الحقول للعرض فقط حتى تُمنح صلاحية تعديل قائمة الأصناف.
      </small>}
    </div>
  );
}
