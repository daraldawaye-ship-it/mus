-- Developer guide correction only; NO business/inventory changes.
-- Correct the previous, now superseded automatic-zero statement in-place.
UPDATE explanation_nodes
SET body=replace(
  body,
  'الإصلاح: إذا كانت كافة حقول العد للوحدات الفعالة تساوي صفرًا، يعرض زر ترحيل باسم تصفير رصيد الصنف ويطلب تأكيد اسم الصنف والموقع، ويرسل zeroLocation:true وcountedUnits.unit1=0 دون shelfId/nearestExpiryDate/compositionId. يختفي إلزام الرف والانتهاء من الشاشة أثناء التصفير؛ ويبقى زر تصفير الموقع المحدد مستقلاً ويعمل.',
  'التصحيح المعتمد بعد توضيح المالك في 2 نوفمبر 2026: لا تستنتج التصفير من كون الكمية المعدودة 0، سواء في وحدة أو كل الوحدات. عند الضغط على ترحيل تسوية الجرد تُرحّل الكمية المدخلة نفسها كتسوية عادية (ولو صفرًا)، دون zeroLocation:true ودون تغيير اسم الزر. فقط عند الضغط الصريح على زر تصفير الموقع المحدد ينفذ تصفير الموقع إلى 0 دون اختيار رف أو أقرب انتهاء أو تركيب. تبقى معالجة المخزون السالب في الخادم عند zeroLocation:true، وتبقى متطلبات التسوية العادية بما فيها الرف والانتهاء والتركيب وصلاحيات المستخدم. هذا التصحيح يلغي وصف التصفير التلقائي السابق.'
)
WHERE import_key='developer-zero-negative-stock-no-expiry-20261102';

INSERT INTO explanation_nodes
  (group_id,parent_id,position,kind,title,body,import_key)
SELECT g.id,NULL,
  COALESCE((SELECT max(n.position) FROM explanation_nodes n WHERE n.group_id=g.id AND n.parent_id IS NULL),0)+1,
  'heading',
  'تصحيح التصفير: فقط بزر تصفير الموقع، لا تلقائياً عند إدخال صفر — 2 نوفمبر 2026',
  'الطلب النهائي للمالك: «لا تلزمني اصفر الصنف، أنا اقصد في حالة الضغط على تصفير أنه لا يطلب تاريخ ولا رف، قد لا أصفره، أدخل الكمية المتوفرة». لذلك أُلغي اكتشاف تصفير الصنف تلقائياً من قيمة العدد المدخل صفرًا، ولم يعد زر «ترحيل تسوية الجرد» يتبدل إلى «تصفير رصيد الصنف». يتيح الإدخال العادي تسجيل العدد الفعلي لأي كمية (بما فيها صفر) وترحيله في تسوية جرد بالشروط العادية للرف وتاريخ الانتهاء والتركيب. عند الضغط حصراً على زر «تصفير الموقع المحدد» تؤكد الواجهة العملية ثم ترسل zeroLocation:true وcountedUnits.unit1=0 دون رف أو تاريخ انتهاء أو تركيب. يستطيع زر التصفير العمل حتى لو الرقم المكتوب في حقل الكمية المعدودة غير صفر لأن اختيار الزر يعبّر عن رغبة المستخدم في تصفير الموقع كله. كما يعمل التصفير مع الرصيد السالب، ولا يتطلب أقرب انتهاء جديدًا لإزالة المخزون السالب. يجب ألا تفقد قيود الصلاحية والتحقق من الرصيد المتوقع وتسجيل الحركة المحاسبية ومنع التكرار. التصحيح في apps/web/src/pages/InventoryPages.tsx وtests/zero-negative-stock.test.ts؛ API في routes-inventory.ts يبقى كما هو. يُمنع إرجاع التصفير التلقائي لاحقاً.',
  'developer-zero-button-explicit-only-20261102'
FROM explanation_groups g WHERE g.slug='site-developer-guide'
ON CONFLICT(import_key) DO NOTHING;
