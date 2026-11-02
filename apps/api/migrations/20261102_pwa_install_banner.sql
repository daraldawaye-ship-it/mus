-- UI-only deployment; keep the actual developer guide in PostgreSQL in sync
-- without a custom write API and without changing business/stock/account data.
INSERT INTO explanation_nodes
  (group_id,parent_id,position,kind,title,body,import_key)
SELECT g.id,NULL,
  COALESCE((SELECT max(n.position) FROM explanation_nodes n
    WHERE n.group_id=g.id AND n.parent_id IS NULL),0)+1,
  'heading',
  'تثبيت تطبيق الرئيسي — زر واضح أعلى الموقع على أندرويد وآيفون ولابتوب (2 نوفمبر 2026)',
  'تصحيح توجيه المالك: معظم المستخدمين لا يعرفون تثبيت تطبيق الويب؛ فقسم التثبيت الاختياري أسفل الموقع لا يكفي. الآن يظهر شريط عريض أسفل شريط عنوان الموقع وقبل محتوى الصفحة وزر تثبيت كبير على المتصفح سواء جاء المستخدم من رابط تسجيل الدخول المباشر أو فتح الموقع العادي. يظهر على Android وiPhone واللابتوب، ويختفي داخل نافذة التطبيق المثبت standalone أو عند حدث appinstalled فقط، بلا حفظ زر لاحقًا ولا تكرار تعليمات التثبيت أسفل الصفحة. في Android/Chrome وChromium laptop يستغل زر المستخدم حدث beforeinstallprompt إذا وفره المتصفح، ولا يجوز استدعاء prompt بدون تفاعل المستخدم؛ عند غياب الحدث يقدم خطوات قائمة المتصفح لتثبيت التطبيق. في iPhone/iPad لا يمكن استدعاء prompt نظامي للتثبيت قسرًا، لذلك الزر يعرض خطوات عربية مرقمة وواضحة: إن فتح من واتساب اختر فتح في Safari؛ ثم اضغط المشاركة، ثم إضافة إلى الشاشة الرئيسية، واترك فتح كتطبيق ويب نشطًا إن ظهر، ثم إضافة، وبعدها افتح الرئيسي من أيقونته. لا يتطلب App Store. شريط التثبيت ليس نافذة حاجزة تحول دون الفواتير أو العمل دون اتصال أو تسجيل الدخول. يبقى AppSetup لتهيئة OfflineStatus وDevicePushBootstrap ولا تظهر فيه قائمة التثبيت المكررة. الملفات: apps/web/src/InstallBanner.tsx وApp.tsx وAppSetup.tsx وstyles.css؛ وحدة install موجودة سابقًا apps/web/src/app-install.ts؛ الاختبارات tests/app-install.test.ts وtests/prominent-pwa-install-banner.test.ts. مرجع Apple https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios وMDN https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable . لا يتم تنزيل تطبيق أصلي ولا تغيير هوية manifest/scope ولا التعديل في صلاحيات المستخدم.',
  'developer-prominent-pwa-install-banner-20261102'
FROM explanation_groups g WHERE g.slug='site-developer-guide'
ON CONFLICT(import_key) DO NOTHING;
