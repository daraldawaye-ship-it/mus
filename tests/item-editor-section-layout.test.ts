import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const editor = readFileSync("apps/web/src/pages/ItemsPages.tsx", "utf8");
const imageUpload = readFileSync("apps/web/src/ImageUpload.tsx", "utf8");

test("item primary fields stay in the primary section and secondary fields move below clearance", () => {
  const first = editor.indexOf('<Card title="بيانات الصنف">');
  const sales = editor.indexOf('title="الوحدات وأسعار البيع"', first);
  const clearance = editor.indexOf('<Card title="عمولة التصريف">', sales);
  const other = editor.indexOf('<Card title="بيانات أخرى">', clearance);
  const settlement = editor.indexOf('<Card title="إعدادات إحصائيات التسويات">', other);
  assert(first >= 0 && first < sales && sales < clearance && clearance < other && other < settlement);
  const main = editor.slice(first, sales);
  const extras = editor.slice(other, settlement);
  for (const label of ["اسم الصنف", "شكل الصنف", "الاسم بالإنجليزية", "الاختصارات", "الرف الحالي", "مفاتيح البحث", "التركيب"]) {
    assert(main.includes(label), `primary section missing ${label}`);
  }
  for (const label of ["اختيار مؤقت", "رمز الصنف", "المعرف في النظام السابق", "الباركود", "وكيل الصنف", "الصنف من المورد", "عملة الأسعار", "له تاريخ انتهاء", "شهر وسنة أقرب انتهاء", "مؤرشف", "مطلوب_جرده"]) {
    assert(extras.includes(label), `secondary section missing ${label}`);
    if (label !== "مؤرشف") assert(!main.includes(label), `secondary field ${label} still in primary section`);
  }
  assert(extras.indexOf('ImageUpload purpose="item"') < extras.indexOf('item-stocktake-required'));
  assert(extras.indexOf("temporarySelection.toggle") >= 0);
  assert(!extras.includes("يمكن تغييره يدويًا؛ ويتحدث عند شراء كمية"));
  assert(!main.includes("اختصار فريد من خانة أو خانتين"));
  assert(main.includes('className="field floating-ready" data-label-raised={fields.shortcut ? "true" : "false"}'));
  assert(main.includes('<label htmlFor="item-shortcut">الاختصارات (خانة أو خانتان)</label>'));
  assert(!main.includes('placeholder="مثل A أو 5. أو ++"'));
});

test("item image upload does not render the thumbnail explanation", () => {
  assert(imageUpload.includes('purpose!=="item" && <small'));
  assert(imageUpload.includes("تُنشأ نسخة مصغرة تلقائيًا"));
});
