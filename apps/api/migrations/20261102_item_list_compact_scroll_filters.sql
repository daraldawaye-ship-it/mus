-- Documentation only: no inventory, finance or account changes.
INSERT INTO explanation_nodes
  (group_id,parent_id,position,kind,title,body,import_key)
SELECT g.id,NULL,
  COALESCE((SELECT max(n.position) FROM explanation_nodes n WHERE n.group_id=g.id AND n.parent_id IS NULL),0)+1,
  'heading',
  'قائمة الأصناف: الفلاتر داخل مساحة سحب بارتفاع صفّين ونصف وعناوين داخل الحقول (2 نوفمبر 2026)',
  'حسب طلب المالك بالصورة، نموذج «خيارات قائمة الأصناف» في /companies/:companyId/item-options-list لا ينبغي أن يستهلك طول الصفحة، لأن عناوين الفلاتر كانت فوق الحقول. وضعنا البحث وحالة الصنف وعشرة نطاقات رقمية ضمن حاوية .item-options-filter-scroll قابلة للتمرير الرأسي (ارتفاع 146px تقريبًا، أي صفّان ونصف بارتفاع 52px للصف، والباقي يظهر بالتمرير الداخلي). على اللابتوب عمودان من الحقول، وعلى الهاتف عمود واحد، وتبقى التسمية داخل كل حقل نفسه وفوق قيمته دون إخفائها عند إدخال رقم. الحقول مُعلَّمة بعناصر label حقيقية؛ اسم الحقل يبقى متاحًا لقارئات الشاشة. تظهر checkboxes الخاصة باستثناء الأصناف ذات الكمية الصفرية واستخدام الكفاية مع الاحتياطي وأزرار تطبيق الخيارات وإعادة الافتراضيات أسفل منطقة السحب وخارجها؛ وتبقى مرئية في جميع الأوقات. لا تغيّر فلاتر الخادم أو افتراضات الكمية 1/1 أو الفراغ الذي يعني دون حد أو الترتيب الافتراضي (مرات منذ البدء تنازليًا). لا تعديل للبيانات المحاسبية/المخزون، ولا تغيير لصلاحيات المبيعات. ملفات التعديل apps/web/src/pages/ItemOptionsListPage.tsx وapps/web/src/styles.css؛ اختبارات tests/item-list-compact-scroll-filters.test.ts وسير .github/workflows/item-list-compact-scroll-filters-ci.yml. لتجنب تكرار مشكلات ارتفاع النوافذ، اجعل التمرير على صندوق الفلاتر فقط، ولا تغير position الخاص بالنافذة العامة أو user-menu.',
  'developer-item-list-compact-scroll-filters-20261102'
FROM explanation_groups g WHERE g.slug='site-developer-guide'
ON CONFLICT(import_key) DO NOTHING;
