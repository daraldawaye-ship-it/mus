-- Quick messages reuse the existing private chat (including notifications).
-- Only a user's own private notes can be read later. Never expose their body
-- through general/company list APIs, notifications or audit logs.
CREATE TABLE IF NOT EXISTS user_private_notes (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_request_id UUID NOT NULL,
  title VARCHAR(200) NOT NULL CHECK(length(btrim(title))>0),
  body TEXT NOT NULL CHECK(length(body)>0 AND length(body)<=3500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(user_id,client_request_id)
);
CREATE INDEX IF NOT EXISTS user_private_notes_owner_date
  ON user_private_notes(user_id,created_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS user_quick_messages (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_request_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('system_change','present_employees','all_employees','app_manager')),
  company_id INTEGER REFERENCES companies(id),
  payload_hash CHAR(64) NOT NULL,
  recipient_ids INTEGER[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(user_id,client_request_id)
);

INSERT INTO explanation_nodes
  (group_id,parent_id,position,kind,title,body,import_key)
SELECT g.id,NULL,
  COALESCE((SELECT max(n.position) FROM explanation_nodes n WHERE n.group_id=g.id AND n.parent_id IS NULL),0)+1,
  'heading',
  'زر الإضافة السريعة بقائمة المستخدم: رسائل الإدارة والموظفين ومذكرة شخصية — 2 نوفمبر 2026',
  'حسب طلب المالك أضف بجوار صف إجراءات قائمة المستخدم في الأسفل زر + صغيرًا مع إزاحة الأزرار الأخرى قليلًا، يعرض خمسة خيارات: طلب تعديل النظام (لموظفي الشركة)، رسالة لجميع المحضرين (لموظفي الشركة)، رسالة لجميع الموظفين (لموظفي الشركة)، رسالة إلى مسؤول التطبيق (للمستخدمين)، ومذكرة خاصة بي (للمستخدمين، وتأجيل مكان العرض التفصيلي). تستخدم الرسائل واجهة POST /api/quick-messages، وتوزع إلى المحادثات الخاصة بالنظام الحالي عبر sendChatMessage حتى يصدر إشعار Chat لكل مستلم، والإشعارات للإدارة أيضًا في طلب تعديل النظام ورسالة مسؤول التطبيق. المحضرون هم أصحاب حضور مفتوح attendance_records.checked_out_at IS NULL في الشركة، وليس مجرد مستخدمي الإنترنت، وتُستبعد الحسابات المؤرشفة/الموقوفة والمرسل نفسه. جميع الموظفين = عضويات نشطة للمستخدمين النشطين في نفس الشركة. رسائل الإدارة تذهب إلى الحسابات المصرح بها owner/admin في الدردشة العامة. يفرض الخادم عضوية الشركة وصلاحيات الدردشة القائمة، ويحدد المستلمين بنفسه ولا يقبل اختيار IDs من الواجهة. حفظ المذكرة الخاصة يتم في جدول user_private_notes لصاحب الحساب فقط دون إخطار أو ظهور محتواها في سجل التدقيق، ولا يتم إنشاء مهام آلية. منع التكرار UUID على مستوى طلب الإرسال، وداخل كل رسالة يُستعمل clientMessageId مشتق حتميًا من الطلب والمستلم. المسارات في apps/api/src/routes-quick-messages.ts، والواجهة UserMenu.tsx مع UserMenuQuickCompose.tsx. يجب فحص الأداء والمخاطر لدى الرسائل الجماعية؛ لا تُشغّل إرسالًا تجريبيًا لموظفين حقيقيين.',
  'developer-avatar-quick-message-20261102'
FROM explanation_groups g WHERE g.slug='site-developer-guide'
ON CONFLICT(import_key) DO NOTHING;
