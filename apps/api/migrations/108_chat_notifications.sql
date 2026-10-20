-- Make new private and group chat messages visible in the existing notifications
-- inbox and on subscribed phones, independently per public/company scope.
INSERT INTO notification_templates
(code,name,category,scope,description,implemented,can_disable,default_importance,default_notify_managers)
VALUES
('CHAT_DIRECT_GLOBAL','رسالة خاصة جديدة','الدردشة','public','تنبيه خاص بمستلم رسالة جديدة في دردشة الرئيسي.',true,true,'high',false),
('CHAT_DIRECT_COMPANY','رسالة خاصة بالشركة','الدردشة','company','تنبيه خاص بمستلم رسالة جديدة في دردشة الشركة.',true,true,'high',false),
('CHAT_GROUP_GLOBAL','رسالة مجموعة جديدة','الدردشة','public','تنبيه لأعضاء مجموعة الدردشة العامة باستثناء المرسل.',true,true,'medium',false),
('CHAT_GROUP_COMPANY','رسالة مجموعة بالشركة','الدردشة','company','تنبيه للأعضاء الحاليين في مجموعة دردشة الشركة باستثناء المرسل.',true,true,'medium',false)
ON CONFLICT(code) DO NOTHING;
