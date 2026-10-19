import { pageDefinitions, permissionKeys, permissionLabels } from "../../../../packages/contracts/src/index.ts";
import { controlCatalog } from "./control-catalog.ts";

export type CentralResource = {
  key:string; name:string; section:string;
  kind:"page"|"field"|"button"|"permission"|"control";
  description:string;
  /** Published definition only: individual controls need server-side integration before enforcement. */
  integrated:boolean;
};
const fields: readonly [string,string,string][] = [
  ["employees.name","الموظفون","اسم الموظف"],
  ["employees.phone","الموظفون","هاتف الموظف"],
  ["employees.positions","الموظفون","صفات الموظف"],
  ["employees.permissions","الموظفون","منح صلاحيات الموظف"],
  ["employees.password","الموظفون","إعادة تعيين كلمة المرور"],
  ["employees.account-links","الموظفون","الصندوق والحافظة والسلفة المرتبطة"],
  ["employees.attendance","الموظفون","إعدادات حضور الموظف وانصرافه"],
  ["items.name","كرت الصنف","اسم الصنف"],
  ["items.code","كرت الصنف","رمز الصنف"],
  ["items.barcode","كرت الصنف","الباركود"],
  ["items.english-name","كرت الصنف","اسم الصنف بالإنجليزية"],
  ["items.product-form","كرت الصنف","شكل الصنف"],
  ["items.composition","كرت الصنف","التركيب"],
  ["items.shelf","كرت الصنف","الرف"],
  ["items.sale-price1","كرت الصنف","سعر البيع الأول"],
  ["items.sale-price2","كرت الصنف","سعر البيع الثاني"],
  ["items.sale-price3","كرت الصنف","سعر البيع الثالث"],
  ["items.purchase-price","كرت الصنف","سعر الشراء"],
  ["items.supplier","كرت الصنف","المورد"],
  ["items.expiry","كرت الصنف","أقرب تاريخ انتهاء"],
  ["items.commission","كرت الصنف","عمولة التصريف"],
  ["items.sale-notes","كرت الصنف","ملاحظات عند البيع"],
  ["items.purchase-notes","كرت الصنف","ملاحظات الشراء"],
  ["items.units","كرت الصنف","الوحدات وعوامل التحويل"],
  ["items.active","كرت الصنف","حالة الصنف والأرشفة"],
  ["compositions.name","كرت التركيب","اسم التركيب"],
  ["compositions.product-form","كرت التركيب","شكل التركيب"],
  ["compositions.alternative","كرت التركيب","البديل المطابق"],
  ["compositions.non-interchangeable","كرت التركيب","غير قابل للتبديل"],
  ["compositions.sale-notes","كرت التركيب","ملاحظات عند البيع"],
  ["accounts.name","كرت الحساب","اسم الحساب"],
  ["accounts.code","كرت الحساب","رقم الحساب"],
  ["accounts.category","كرت الحساب","فئة الحساب"],
  ["accounts.pledges","كرت الحساب","الرهونات"],
  ["sales.account","فاتورة المبيعات","حساب الفاتورة"],
  ["sales.date","فاتورة المبيعات","تاريخ الفاتورة"],
  ["sales.price","فاتورة المبيعات","تعديل أسعار الأصناف"],
  ["sales.discount","فاتورة المبيعات","الخصم"],
  ["sales.cashbox","فاتورة المبيعات","الصندوق"],
  ["sales.currency","فاتورة المبيعات","العملة"],
  ["sales.notes","فاتورة المبيعات","الملاحظات"],
  ["purchases.supplier","فاتورة المشتريات","المورد الفعلي"],
  ["purchases.price","فاتورة المشتريات","سعر الشراء"],
  ["purchases.expiry","فاتورة المشتريات","تاريخ انتهاء الصنف"],
  ["purchases.receipt-number","فاتورة المشتريات","رقم الوصل"],
  ["inventory.shelf","المخزون","رف الصنف"],
  ["inventory.adjustment","المخزون","تسوية الأصناف"],
  ["inventory.nearest-expiry","المخزون","أقرب تاريخ انتهاء"],
  ["receipts.account","سند القبض","الحساب المقابل"],
  ["payments.account","سند الصرف","الحساب المقابل"],
  ["memos.recipient","المذكرات","مستلم المذكرة"],
  ["memos.followers","المذكرات","متابعو المذكرة"],
  ["memos.status","المذكرات","حالة المذكرة"],
  ["chat.members","الدردشة","أعضاء مجموعة الدردشة"],
  ["rewards.points","المكافآت","رصيد نقاط الموظف"],
  ["attendance.time","الحضور والانصراف","وقت الحضور والانصراف"],
];
const buttons:readonly [string,string,string][]=[
  ["sales.save","فاتورة المبيعات","حفظ الفاتورة"],
  ["sales.post","فاتورة المبيعات","ترحيل الفاتورة"],
  ["sales.reverse","فاتورة المبيعات","عكس الفاتورة"],
  ["sales.clear","فاتورة المبيعات","تصفير الفاتورة"],
  ["sales.close-cashbox","فاتورة المبيعات","إغلاق الصندوق"],
  ["purchases.save","فاتورة المشتريات","حفظ الفاتورة"],
  ["purchases.post","فاتورة المشتريات","ترحيل الفاتورة"],
  ["purchases.reverse","فاتورة المشتريات","عكس الفاتورة"],
  ["items.save","كرت الصنف","حفظ الصنف"],
  ["items.adjust","المخزون","جرد وتسوية الصنف"],
  ["items.archive","كرت الصنف","أرشفة الصنف"],
  ["inventory.transfer","المخزون","ترحيل مناقلة"],
  ["pouch.receive","استلام الترحيلات","استلام مطابق"],
  ["pouch.partial","استلام الترحيلات","استلام جزئي"],
  ["electronic.receive","استلام المحفظة","استلام المحفظة الإلكترونية"],
  ["financial.post","المالية","ترحيل قيد أو سند"],
  ["financial.reverse","المالية","عكس قيد أو سند"],
  ["memos.create","المذكرات","إرسال مذكرة"],
  ["memos.approve","المذكرات","اعتماد المذكرة"],
  ["memos.close","المذكرات","إغلاق المذكرة"],
  ["chat.manage","الدردشة","إدارة المجموعة"],
  ["notifications.manage","التنبيهات","إدارة التنبيهات"],
  ["tasks.manage","المهام","الإشراف على المهام"],
  ["attendance.approve","الحضور والانصراف","اعتماد التعديلات"],
  ["rewards.adjust","المكافآت","تعديل النقاط"],
  ["reports.print","التقارير","طباعة التقارير"],
  ["reports.export","التقارير","تصدير التقارير"],
];
export const centralResources:readonly CentralResource[]=[
  ...pageDefinitions.filter(p=>p.scope==="company").map(p=>({
    key:`page:${p.key}`,name:p.name,section:p.section,kind:"page" as const,
    description:p.description,integrated:false,
  })),
  ...permissionKeys.map(key=>({
    key:`permission:${key}`,name:permissionLabels[key],
    section:"صلاحيات الموظفين",kind:"permission" as const,
    description:"صلاحية النظام القديمة محفوظة أثناء الانتقال إلى الصلاحيات المركزية.",
    integrated:false,
  })),
  ...controlCatalog.map(c=>({
    key:`control:${c.key}`,name:c.label,section:`الكنترول / ${c.category}`,
    kind:"control" as const,description:c.description??"",integrated:false,
  })),
  ...fields.map(([key,section,name])=>({
    key:`field:${key}`,name,section,kind:"field" as const,description:"",
    integrated:false,
  })),
  ...buttons.map(([key,section,name])=>({
    key:`button:${key}`,name,section,kind:"button" as const,description:"",
    integrated:false,
  })),
];
const index=new Map(centralResources.map(r=>[r.key,r]));
if(index.size!==centralResources.length)throw Error("Duplicate central access resource keys");
export function centralResource(key:string):CentralResource|undefined{return index.get(key);}
