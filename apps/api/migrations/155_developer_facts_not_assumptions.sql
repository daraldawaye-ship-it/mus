-- 29 October 2026: preserve the owner's explicit editorial instruction as a
-- labelled instruction, and preserve observed system facts as facts.
-- Do not turn suggested solutions into owner directives.
INSERT INTO explanation_nodes
  (group_id,parent_id,position,kind,title,body,import_key)
SELECT g.id,NULL,0,'heading',
  'طريقة قراءة دليل المطور: معطيات النظام والتوجيهات الصريحة',
  'تحديث 29 أكتوبر 2026. طلب المالك صراحة أن يحتوي دليل المطور على معطيات مثبتة عن النظام لا توجيهات تقنية مستنتجة. أي توجيه يُنسب إلى المالك فقط إذا صدر منه بعبارة صريحة وواضحة. الحلول المعمارية وخطوات التنفيذ السابقة تظل وصفًا لتطبيقات فنية أو مقترحات، ولا تُفهم باعتبارها تعليمات ملزمة صادرة عنه. الصيغ الإجرائية القديمة في الفصول الأخرى ليست، بمجرد ورودها في هذا الدليل، دليلًا على صدور توجيه من المالك؛ المرجع هو نص طلبه الصريح وسياقه.',
  'developer-facts-directives-20261029'
FROM explanation_groups g
WHERE g.slug='site-developer-guide'
ON CONFLICT (import_key) DO NOTHING;

INSERT INTO explanation_nodes
  (group_id,parent_id,position,kind,title,body,import_key)
SELECT g.id,p.id,1,'paragraph',
  'معطيات ثابتة عن نظام الفواتير والبحث في 29 أكتوبر 2026',
  'المنصة: الرئيسي | Alraesy. المستودع daraldawaye-ship-it/mus؛ فرع خدمة Render الفعلي عند الفحص preview/render-2026-10-23، والرابط https://alraesy-private-preview.onrender.com. رغم اسم preview التاريخي فإن هذه الخدمة هي الموقع المعتمد.\nشركة صيدلية دار الدواء: company_id=2. مصدر الفواتير dar-aldawa-legacy-2026-10. جدول raw_transferred_invoices وكذلك legacy_import_staging احتوى 87,211 فاتورة مصدر فريدة: 65,210 مبيعات و22,001 مشتريات؛ منها 2,327 بتاريخ أكتوبر 2026.\nحالة صفوف تجهيز المبيعات في لقطة 29 أكتوبر: 46,129 completed، و17,236 excluded، و1,845 failed، وصفر pending؛ أي 19,081 مبيعات غير مكتملة الترحيل النهائي في هذه اللقطة. هذه الأعداد لحظة فحص وليست عدادات أبدية. لم تُحسب كل الفواتير الخام حركة مخزون أو قيودًا مالية.\nبنية القراءة القائمة قبل أي تعديل جديد: مسار commerce-options?type=items يبحث في بطاقات items، وفرز مرات البيع الشهرية يقرأ item_sale_rankings المشتق من item_daily_activity. تقرير إحصاءات الأصناف item-statistics-report يعرض مرات البيع خلال شهر و4 أشهر و12 شهرًا ومنذ البداية، ويعتمد في نسخته المفحوصة على item_daily_activity، أي بيانات الترحيل الفعلي. الحفظ الأولي للفاتورة مستند مصدر مستقل عن أثر المخزون والقيود.',
  'developer-invoice-facts-20261029'
FROM explanation_groups g
JOIN explanation_nodes p ON p.group_id=g.id AND p.import_key='developer-facts-directives-20261029'
WHERE g.slug='site-developer-guide'
ON CONFLICT (import_key) DO NOTHING;

INSERT INTO explanation_nodes
  (group_id,parent_id,position,kind,title,body,import_key)
SELECT g.id,p.id,2,'paragraph',
  'التوجيهات الموثقة بعبارة صريحة من المالك — 29 أكتوبر',
  'نص المالك بشأن أسلوب دليل المطور: «أريد الإرشادات المطور تحتوي على المعطيات وليس التوجيهات ... اكتب التوجيهات الصريحة والواضحة مني فقط».\nنص المالك في موضوع الفواتير الأولية: «المهم تظهر عند البحث وتحسب في المبيعات مرات في شهر وفي عام». وقال في توضيح معنى أوليًا: «أوليا يعني غير محسوبه مخزنيا».\nالوثيقة تميّز هذه المطالب الصريحة عن أي حل تقني اختاره المطور أو اقترحه لاحقًا. لا يُنسب إلى المالك اختيار جداول مشتقة أو triggers أو طريقة مزامنة بعينها ما لم يطلب ذلك صراحة.',
  'developer-owner-explicit-instructions-20261029'
FROM explanation_groups g
JOIN explanation_nodes p ON p.group_id=g.id AND p.import_key='developer-facts-directives-20261029'
WHERE g.slug='site-developer-guide'
ON CONFLICT (import_key) DO NOTHING;

-- One user-facing clarification only; no technical implementation is asserted.
INSERT INTO explanation_nodes
  (group_id,parent_id,position,kind,title,body,import_key)
SELECT g.id,p.id,1,'paragraph',
  'معنى الحفظ الأولي للفواتير التاريخية',
  'الحفظ الأولي يعني الاحتفاظ ببيانات الفاتورة المستوردة دون أن يُثبت ذلك وحده احتسابها في المخزون أو الحسابات. وجود المستند في سجل المصدر يختلف عن ترحيله النهائي. في 29 أكتوبر 2026 طلب المالك أن تظهر الفواتير الأولية عند البحث وأن تدخل في عدد مرات البيع خلال الشهر والسنة. وصف هذا الطلب لا يعني وحده تأكيد نشر التنفيذ في الموقع.',
  'user-guide-provisional-invoices-20261029'
FROM explanation_groups g
JOIN explanation_nodes p ON p.group_id=g.id AND p.import_key='site-guide-user-014'
WHERE g.slug='site-user-guide'
ON CONFLICT (import_key) DO NOTHING;
