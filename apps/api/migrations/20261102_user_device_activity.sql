-- Device login and server-confirmed Web Push registration, without IP, UA history
-- or sensitive push endpoint material. Unknown history stays NULL.
CREATE TABLE IF NOT EXISTS user_device_activity (
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_kind text NOT NULL CHECK (device_kind IN
    ('desktop_browser','mobile_browser','android_app','iphone_app')),
  last_login_at timestamptz,
  last_push_confirmed_at timestamptz,
  last_push_permission text CHECK(last_push_permission IN ('granted','denied','default','unsupported')),
  last_push_permission_checked_at timestamptz,
  PRIMARY KEY (user_id, device_kind)
);
ALTER TABLE web_push_subscriptions
  ADD COLUMN IF NOT EXISTS device_kind text;
ALTER TABLE web_push_subscriptions
  ADD CONSTRAINT web_push_subscription_device_kind_check
    CHECK (device_kind IS NULL OR device_kind IN
      ('desktop_browser','mobile_browser','android_app','iphone_app'));
CREATE INDEX IF NOT EXISTS web_push_user_kind_idx
  ON web_push_subscriptions(user_id,device_kind);

-- Keep the on-site developer explanations in sync with this database-backed
-- feature. The import_key prevents duplicate nodes on repeated deployment.
INSERT INTO explanation_nodes
  (group_id,parent_id,position,kind,title,body,import_key)
SELECT g.id,NULL,
  COALESCE((SELECT MAX(n.position) FROM explanation_nodes n
            WHERE n.group_id=g.id AND n.parent_id IS NULL),0)+1,
  'heading',
  'تمييز جهاز الدخول والإشعارات في قائمة المستخدمين (2 نوفمبر 2026)',
  'طلب المالك صراحةً أربعة أعمدة لآخر دخول (متصفح اللابتوب، متصفح الهاتف، تطبيق أندرويد، تطبيق آيفون)، وبيان آخر تفعيل للإشعارات من التطبيق واللابتوب إن أمكن. التنفيذ: جدول user_device_activity يسجل آخر دخول ناجح وآخر تأكيد اشتراك Web Push وآخر حالة إذن للإشعارات يبلغ عنها الجهاز، لكل مستخدم ولكل نوع جهاز، دون تتبع صفحات التصفح أو تخزين عنوان IP أو تاريخ تصفح. تتحدد الفئة من User-Agent مع إشارة وضع standalone من التطبيق المثبّت في طلب الموقع؛ تصنيف التطبيقات هنا يعني PWA المثبّت وليس تطبيقًا أصليًا. يسجل تسجيل الدخول بكلمة المرور أو Google أو Apple، ولا يساوى آخر النشاط بآخر تسجيل دخول. تربط web_push_subscriptions بـ device_kind ويعرض GET /users تواريخ الجهاز وحالة الاشتراك النشط فقط للإدارة المخولة الموجودة أصلًا. قد يسحب صاحب الجهاز إذن الإشعارات دون إخطار الخادم، لذلك الاشتراك المرتبط ليس تأكيدًا حيًا لسماح نظام التشغيل؛ حالة الإذن هي آخر تصريح أرسله الجهاز عند نشاطه وهي غير مباشرة وقد تصبح قديمة بعد إغلاق التطبيق. البيانات السابقة قبل التحديث غير مصنفة وتظهر بشرطة، ولا يجوز اختلاق تاريخ رجعي. ملفات المصدر: migrations/20261102_user_device_activity.sql وservices/user-device-activity.ts وroutes-auth.ts وroutes-social-auth.ts وroutes-push.ts وroutes-public.ts وweb/src/device-kind.ts وweb/src/pages/PublicPages.tsx، والاختبار tests/user-device-activity.test.ts. لا يغير هذا أي ترحيل محاسبي أو صلاحية مستخدم.',
  'developer-users-device-activity-20261102'
FROM explanation_groups g WHERE g.slug='site-developer-guide'
ON CONFLICT(import_key) DO NOTHING;
