-- Only a developer-guide explanation; fixes no application data.
INSERT INTO explanation_nodes
  (group_id,parent_id,position,kind,title,body,import_key)
SELECT g.id,NULL,
  COALESCE((SELECT max(n.position) FROM explanation_nodes n
    WHERE n.group_id=g.id AND n.parent_id IS NULL),0)+1,
  'heading',
  'إصلاح اختفاء تبويبات قائمة المستخدم بعد زر (+) — 2 نوفمبر 2026',
  'بلاغ المالك بصورة من صفحة المستخدمين: نافذة قائمة الصورة الشخصية أصبحت تصعد أعلى إطار الشاشة وتختفي التبويبات العلوية، بينما يظهر الصف السفلي وزر (+). السبب المحدد: في apps/web/src/user-menu-tabs.css كان آخر تعريف .user-menu-panel.user-menu-tabbed-panel يضع position:relative على نفس العنصر، متجاوزًا .user-menu-panel {position:absolute;top:calc(100% + 6px);inset-inline-end:0} الموجود في apps/web/src/styles.css. هذا يحول القائمة إلى عنصر في تدفق شريط الترويسة منخفض الارتفاع ويسبب اقتطاع الجزء العلوي. الحل: إزالة position:relative من تعريف التبويب، والاعتماد على position:absolute الأصلي. نافذة القائمة absolute نفسها تشكل containing block لخيار + المنسدل position:absolute، لذا لا يلزم إضافة relative إطلاقًا. احتفظ بارتفاع القائمة min(360px, calc(100dvh - 66px))، والتبويبات الستة قابلة للعرض، والصف السفلي 38px، وزر + بجانب تعديل حسابي. لا تنقل قائمة المستخدم إلى داخل التدفق أو تضف position:relative لتوسيع قائمة + مستقبلًا. اختبر بواسطة tests/avatar-menu-position-regression.test.ts ولا تمس الفواتير أو الرسائل أو الحقوق.',
  'developer-avatar-popup-position-fix-20261102'
FROM explanation_groups g WHERE g.slug='site-developer-guide'
ON CONFLICT(import_key) DO NOTHING;
