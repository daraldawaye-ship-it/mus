-- After first due, reminder sequence can stay active without continuing deferral.
ALTER TABLE memo_schedules
 ADD COLUMN returned boolean NOT NULL DEFAULT false,
 ADD COLUMN cycle_index integer NOT NULL DEFAULT 0 CHECK(cycle_index>=0);
INSERT INTO notification_templates(code,name,category,scope,description,implemented,can_disable,default_importance,default_notify_managers)
 VALUES('MEMO_DELAYED','تأخر متابعة مذكرة مرسلة','المذكرات','company',
 'تنبيه اختياري للمرسل عند حلول موعد العودة للمتابعة.',true,true,'low',false);
