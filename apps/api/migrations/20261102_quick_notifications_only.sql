-- Requests from avatar (+) are alerts ONLY. No conversation/chat messages,
-- no chat permission, and no link to chat. These are existing notification
-- infrastructure records, categorized separately from ordinary private chat.
INSERT INTO notification_templates
  (code,name,category,scope,description,implemented,can_disable,default_importance,default_notify_managers)
VALUES
('QUICK_PRESENT_EMPLOYEES','رسالة إلى جميع المحضّرين','رسائل','company',
 'تنبيه موجّه فقط للمحضّرين أصحاب حضور مفتوح وقت الإرسال، مع اسم المرسل ونص الرسالة.',true,false,'high',false),
('QUICK_ALL_EMPLOYEES','رسالة إلى جميع الموظفين','رسائل','company',
 'تنبيه موجّه لجميع الموظفين ذوي العضوية النشطة، مع اسم المرسل ونص الرسالة.',true,false,'high',false),
('QUICK_SYSTEM_CHANGE','طلب تعديل النظام','رسائل','public',
 'طلب تعديل النظام موجّه لحسابات الإدارة دون اشتراط الدخول للدردشة، مع نص الطلب.',true,false,'high',false),
('QUICK_APP_MANAGER','رسالة إلى مسؤول التطبيق','رسائل','public',
 'رسالة خاصة بإدارة الموقع ضمن التنبيهات فقط، مع نصها.',true,false,'high',false)
ON CONFLICT(code) DO NOTHING;

INSERT INTO explanation_nodes
  (group_id,parent_id,position,kind,title,body,import_key)
SELECT g.id,NULL,
  COALESCE((SELECT max(n.position) FROM explanation_nodes n WHERE n.group_id=g.id AND n.parent_id IS NULL),0)+1,
  'heading',
  'رسائل زر (+) إشعارات مستقلة فقط دون دردشة أو صلاحيات دردشة (2 نوفمبر 2026)',
  'تصحيح طلب المالك بعد ملاحظة أن إشعار الرسائل الجماعية/الإدارة ظهر بعنوان رسالة من Admin وبعبارة أرسل إليك رسالة خاصة جديدة وعند فتحه قال لا توجد صلاحيات لأن المسار ربط بالدردشة. القرار النهائي: رسائل زر (+) لا علاقة لها بالدردشة إطلاقاً. تُرسل فقط إلى نظام notifications القائم باستخدام emitNotification مع وصول مستهدف من الخادم ورسالة مصنفة تحتوي اسم المرسل والنص الكامل. الأنواع المستقلة QUICK_PRESENT_EMPLOYEES (رسالة إلى جميع المحضّرين) وQUICK_ALL_EMPLOYEES (رسالة إلى جميع الموظفين) في الشركة، وQUICK_SYSTEM_CHANGE (طلب تعديل النظام) وQUICK_APP_MANAGER (رسالة إلى مسؤول التطبيق) في الموقع العام للإدارة. لا تُنشئ chat_messages أو chat_conversations ولا تستخدم chat.send أو صلاحيات الشركة للدردشة. يقتصر فتحها على صفحة التنبيهات المقابلة ويعرض النص هناك بوضوح وبلا اقتطاع في نافذة التنبيهات. ربط الإشعار بمستلمه في الشركة عبر subject_employee_id وrecipient_user_id، وفي العام عبر subject_user_id؛ مع explicitSubjectOnly ومنع تكرار بواسطة user_quick_messages وUUID. استبعاد صاحب الرسالة والحسابات المؤرشفة/الموقوفة. المحضّر هو من له attendance_records.checked_out_at IS NULL فعلاً. كل رسالة معلمة بالعنوان والنص داخل التنبيه ولا تطلب صلاحية دردشة. رسائل الدردشة العادية تبقى مستقلة وبخصوصيتها، ولا تتغير إشعاراتها. المذكرات الشخصية لا تُرسل تنبيهات. ملفات التنفيذ apps/api/src/routes-quick-messages.ts وapps/api/src/services/notifications.ts ونظام العرض web/src/NotificationBell.tsx وstyles.css وUserMenuQuickCompose.tsx؛ الاختبارات tests/avatar-quick-messages.test.ts وtests/quick-notifications-only.test.ts. لا تمس الإشعارات التاريخية القديمة لوجود حماية عدم تغيير هوية سجل الإشعارات.',
  'developer-quick-notifications-only-20261102'
FROM explanation_groups g WHERE g.slug='site-developer-guide'
ON CONFLICT(import_key) DO NOTHING;
