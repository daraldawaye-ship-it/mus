-- Documentation-only: no item stock or numeric filter data is changed.
INSERT INTO explanation_nodes
  (group_id,parent_id,position,kind,title,body,import_key)
SELECT g.id,NULL,
  COALESCE((SELECT max(n.position) FROM explanation_nodes n
    WHERE n.group_id=g.id AND n.parent_id IS NULL),0)+1,
  'heading',
  'تصحيح تداخل عنوان فلتر قائمة الأصناف وحذف «بدون حد» من الحقول — 2 نوفمبر 2026',
  'طلب المالك مع صورة: في خيارات قائمة الأصناف، كان العنوان داخل الحقل يغطّي قيمة الحقل أو عبارة «بدون حد»، خلاف تنسيق كرت الصنف حيث العنوان الصغير أعلى القيمة. سبب المشكلة الدقيق CSS: input:not([type=checkbox]):not([type=radio]) العام بخصوصية (0,2,1) كان يفرض padding:0 9px وارتفاع الحقل الافتراضي، فيفوز على .item-options-filter-field > input بخصوصية (0,1,1) ويلغي المسافة اللازمة أسفل عنوان الفلتر. تم تصحيح التنسيق بمحدد .item-options-filters-card .item-options-filter-field > input وselect بخصوصية (0,2,1) في أسفل CSS ليغلب القاعدة العامة بأولوية الترتيب، ويحدد box-sizing:border-box وheight:var(--item-filter-row-height) وpadding-block:22px 5px وline-height:18px. بذلك يبقى عنوان الحقل في أعلى المستطيل عند top:4px ويظهر الرقم أو الخيار في سطر منفصل تحته، كما في كرت الصنف. أزيلت عبارة placeholder=بدون حد من جميع الفلاتر الرقمية في ItemOptionsListPage.tsx. إخلاء أي حقل رقمي يعني بلا حد عند تطبيق الفلتر تماماً كما كان، دون إظهار نص داخله؛ الافتراضات stockMin=stockMax=1 وباقي المنطق لا تتغير. حافظ على شاشة التمرير الداخلية بارتفاع صفين ونصف، وعلى بقاء الأزرار خارجها، وعلى تصميم الهاتف. لا تغيّر CSS العام للمدخلات، ولا إعادة منطق placeholder للحدود. الاختبار tests/item-list-compact-scroll-filters.test.ts؛ توثيق docs/DEVELOPER_GUIDE.md؛ لا أي تعديل على الأرصدة أو البيانات.',
  'developer-item-list-embedded-label-spacing-20261102'
FROM explanation_groups g WHERE g.slug='site-developer-guide'
ON CONFLICT(import_key) DO NOTHING;
