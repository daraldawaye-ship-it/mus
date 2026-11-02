-- Owner-created short-lived sign-in links for existing non-owner users.
-- A single outstanding link per user; new links replace the previous one.
-- Persist only a SHA-256 digest, never the bearer token itself.
CREATE TABLE IF NOT EXISTS user_login_links (
  user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  issued_by integer REFERENCES users(id) ON DELETE SET NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK(expires_at>issued_at)
);
CREATE INDEX IF NOT EXISTS user_login_links_expiry_idx
  ON user_login_links(expires_at);

-- Explain the intentional reduction in minimum password length and security
-- restrictions of admin-issued one-use sign-in links on the website itself.
INSERT INTO explanation_nodes
  (group_id,parent_id,position,kind,title,body,import_key)
SELECT g.id,NULL,
  COALESCE((SELECT max(n.position) FROM explanation_nodes n
            WHERE n.group_id=g.id AND n.parent_id IS NULL),0)+1,
  'heading',
  'كلمات مرور من 3 أحرف وروابط دخول شخصية صالحة لساعة (2 نوفمبر 2026)',
  'توجيه المالك: السماح بحد أدنى 3 أحرف أو أرقام لكلمات المرور في إنشاء الحساب أو تغييره أو إعادة ضبطه بواسطة المالك، مع إبقاء الحد الأقصى 128 وتخزين hash scrypt والتحقق القائم. كلمة المرور القصيرة أقل أمنًا ويُنصح المستخدم المعني بمعلومة مهمة باستعمال كلمة أطول. تصحيح لاحق من المالك في الجلسة نفسها: تغيير كلمة المرور لحساب مسجل دخوله لا يلزم إدخال كلمة المرور السابقة؛ المستخدم يدخل الكلمة الجديدة وتأكيدها فقط. الخادم يبقي شرط مصادقة الجلسة وOrigin وCSRF وقفل التزامن وإلغاء جلسات الأجهزة الأخرى والرابط السابق وإشعار التدقيق. في قائمة المستخدمين زر «إنشاء رابط دخول» لمالك المنصة فقط، للحسابات غير المؤرشفة وغير المالكة. ينشئ رابطًا شخصيًا برمز عشوائي 32 بايت (base64url) وليس مشتقًا من الوقت؛ يحتفظ PostgreSQL فقط ببصمة SHA-256 ويجعل الرابط صالحًا لساعة من لحظة إنشائه، والاستخدام لمرة واحدة. كل إصدار جديد لنفس المستخدم يُلغي رابطَه السابق. فتح /quick-login#TOKEN لا ينقل الرمز ضمن URL للخادم أو Referrer؛ يزيل تطبيق React الجزء السري من عنوان المتصفح ثم يستعمل POST /auth/login-link/redeem بنفس الأصل وبحمولة JSON. يستعمل الحماية القياسية للـ Origin وCSRF مع استثناء مخصص لتبديل الجلسة، وقيد محاولات، ويُستهلك الرابط ذريًا في معاملة DELETE RETURNING قبل إنشاء جلسة HttpOnly جديدة وإسناد الهوية. يتعذر استخدام رابط مؤرشف أو مستعمل أو منتهي أو بعد تغيير كلمة المرور، وتسجّل عمليات الإنشاء والاستعمال في سجل التدقيق دون حفظ/تسجيل الرمز أو الرابط. الرابط الذي يتسرب قد يسمح لمستلمه بالدخول خلال ساعة؛ لهذا فهو بمثابة كلمة مرور مؤقتة ويُرسل للجهة المقصودة فقط. الملفات: apps/api/migrations/20261102_user_magic_login_links.sql؛ apps/api/src/routes-auth.ts وroutes-public.ts وhttp.ts؛ packages/contracts/src/index.ts؛ apps/web/src/pages/PublicPages.tsx وQuickLoginPage.tsx وApp.tsx وapi.tsx. هذا لا يغيّر الأذونات الداخلية للمستخدم أو سجل الشركة، ولا يرسل الرسائل تلقائيًا.',
  'developer-user-short-password-one-hour-links-20261102'
FROM explanation_groups g WHERE g.slug='site-developer-guide'
ON CONFLICT(import_key) DO NOTHING;
