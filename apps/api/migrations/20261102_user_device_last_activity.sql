-- Corrected owner request, 2 November 2026: this is LAST INTERACTION,
-- not last successful sign-in. Do not backfill a phone/desktop category from
-- the platform-wide presence row; its device is unknown.
ALTER TABLE user_device_activity
  ADD COLUMN IF NOT EXISTS last_activity_at timestamptz;

-- This replaces the historical developer explanation of "last login"
-- without deleting or rewriting existing human authored content.
INSERT INTO explanation_nodes
  (group_id,parent_id,position,kind,title,body,import_key)
SELECT g.id,NULL,
  COALESCE((SELECT max(n.position) FROM explanation_nodes n
            WHERE n.group_id=g.id AND n.parent_id IS NULL),0)+1,
  'heading',
  'تصحيح: آخر تفاعل للمستخدم حسب الجهاز كل خمس دقائق والترتيب من رؤوس الأعمدة (2 نوفمبر 2026)',
  'التصحيح الصريح من المالك: «لا أقصد آخر دخول أي تسجيل الدخول، أقصد آخر حركة فيه أو تفاعل». وطلب ألّا يتسبب تحديث كل حركة في ضغط؛ يعتمد تحديث كل 5 دقائق للمستخدم بدل كل حركة، مع ترتيب السجلات بالضغط على رأس العمود. التطبيق: الحقول الأربعة في /users تعرض last_activity_at لكل فئة جهاز وليس last_login_at. يتولد الحدث من /presence/heartbeat أثناء نشاط الواجهة الفعلي وظهورها، وليس من خلفية الإشعارات أو كل استعلام HTTP أو مجرد نجاح تسجيل الدخول. العميل يمنع إعادة إرسال الطلب قبل 5 دقائق أثناء النشاط، ويحمي PostgreSQL التواتر مرة واحدة كحد أقصى لكل user_id/device_kind خلال 5 دقائق عبر INSERT ON CONFLICT WHERE؛ حتى مع عدة علامات تبويب أو أجهزة أو عمليات متزامنة. لا تحفظ حركات الضغط والكتابة، بل وقت آخر تفاعل فقط؛ دون اتصال لا تُفترض مزامنة تاريخ رجعي. لا تُنسَب بيانات الحضور العامة الموجودة قبل هذه الميزة إلى جهاز محدد. ترتيب رأس العمود من الخادم على جميع المستخدمين قبل ترقيم الصفحات، مع اتجاهي ASC/DESC وNULLS LAST ومعرف المستخدم ككسر تعادل؛ تدعم كذلك أعمدة الإشعارات والحقول الإدارية الأخرى. ملفات العمل: apps/api/src/services/user-device-activity.ts، routes-public.ts، services/lists.ts، apps/web/src/PresenceHeartbeat.tsx وpages/PublicPages.tsx، الترحيل الحالي، والاختبارات tests/user-device-last-activity.test.ts. حقول last_login_at القديمة تبقى لأغراض التوافق ولا تُعرض بوصفها آخر نشاط. هذا التصحيح يتقدم على وصف آخر الدخول في الدليل السابق، ولا يغير المعاملات المالية.',
  'developer-user-last-interaction-5min-sort-20261102'
FROM explanation_groups g WHERE g.slug='site-developer-guide'
ON CONFLICT (import_key) DO NOTHING;
