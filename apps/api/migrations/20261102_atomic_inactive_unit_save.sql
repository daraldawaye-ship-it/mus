-- Developer documentation only. Never mutate live item units, stock or finance.
INSERT INTO explanation_nodes
  (group_id,parent_id,position,kind,title,body,import_key)
SELECT g.id,NULL,
  COALESCE((SELECT max(n.position) FROM explanation_nodes n
    WHERE n.group_id=g.id AND n.parent_id IS NULL),0)+1,
  'heading',
  'إصلاح حفظ اسم وحدة جديدة ومعامل تحويلها معاً عند صفر المخزون — 2 نوفمبر 2026',
  'بلاغ المالك في كرت الصنف 00015180 (السجل 15182)، «راتناكسوفين 50 ملجم امبول كيتيز» بشركة دار الدواء رقم 2: الوحدة الأولى باكت، الثانية كانت خاملة unit2Name فارغ وfactor2=1، حاول إضافتها باسم أمبولة وعددها 5 لكن فشل حفظها رغم أن جميع مواقع المعرض والمخازن والمرتجعات تعرض كمية صفر في item-location-balances. السبب: نظام حفظ كرت الصنف على مستوى الحقل في ItemsPages.tsx كان يرسل اسم الوحدة وعامل التحويل كل واحد في PATCH منفصل فور فقد التركيز، فترفض validateNames في itemPatchSchema حفظ factor2=5 بينما unit2Name في قاعدة البيانات ما يزال فارغاً، حتى لو ظهر الاسم في الواجهة. الإصلاح: عند تنشيط وحدة خاملة يُرسل الحقلان المعدلان معاً في عملية field patch واحدة تحمل changes وexpected لكلا unit2Name/factor2 (أو unit3Name/factor3) مع last-write-wins الحالي؛ يتوقف إرسال عامل أكبر من 1 إذا الاسم غير مكتمل وتظهر رسالة عربية واضحة. تُزال حقول الزوج من خرائط الحفظ المؤقت والحقول المحظورة معاً بعد النجاح، وتُحفظ أي تعديلات جديدة تحصل أثناء الطلب. لا مساس بالحفظ على مستوى الحقل لبقية بيانات الكرت ولا بإعدادات الوحدات المفعلة تاريخياً. الخادم يحافظ على منع تغيير وحدة قديمة لها حركات مخزون بواسطة addsOnlyPreviouslyInactiveUnits ويشترط رصيد صفر في كل المواقع والدفعات عبر stock_balances.quantity_smallest<>0 مع قفل السجل، فلا يكفي مجموع الشركة وحده. لا تُعدّل مخزون الصنف أو الوحدات من أدوات التطوير دون طلب صريح؛ لا تُجرِ اختبار الترحيل على قاعدة الإنتاج. اختبر schema واستخدام PATCH متعدد الحقول واختبارات TypeScript والبناء وPostgreSQL منعزلة: tests/item-new-unit-atomic.test.ts وtests/items.test.ts وtests/item-unit-history-and-invoice-side.test.ts، وسير .github/workflows/item-new-unit-atomic-ci.yml. وثق السبب لتجنب إضافة وحدات جديدة بترتيب إدخال يسبب رفضاً متكرراً. تعديل الواجهة في apps/web/src/pages/ItemsPages.tsx فقط.',
  'developer-atomic-inactive-unit-save-20261102'
FROM explanation_groups g WHERE g.slug='site-developer-guide'
ON CONFLICT(import_key) DO NOTHING;
