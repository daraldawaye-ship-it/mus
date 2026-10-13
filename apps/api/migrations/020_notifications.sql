INSERT INTO page_registry(key) VALUES('public.notifications'),('public.notification-templates'),('company.notifications'),('company.notification-templates');
INSERT INTO permission_definitions(key,page_key,action,name,rule_role,required_permissions) VALUES
 ('company.notifications:view','company.notifications','view','التنبيهات — عرض','company-member','{}'),
 ('company.notifications:edit','company.notifications','edit','التنبيهات — متابعة','company-member','{}'),
 ('company.notification-templates:view','company.notification-templates','view','أنواع التنبيهات — عرض','company-general','{}'),
 ('company.notification-templates:edit','company.notification-templates','edit','أنواع التنبيهات — تعديل','company-general','{}');
CREATE TABLE notification_runtime(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),activated_at timestamptz NOT NULL DEFAULT now());
INSERT INTO notification_runtime(singleton) VALUES(true);
CREATE TABLE notification_templates(
 code varchar(100) PRIMARY KEY,name text NOT NULL,category text NOT NULL,scope varchar(10) NOT NULL CHECK(scope IN('public','company')),
 description text NOT NULL,implemented boolean NOT NULL,can_disable boolean NOT NULL,default_importance varchar(10) NOT NULL CHECK(default_importance IN('low','medium','high','critical')),
 default_notify_managers boolean NOT NULL DEFAULT true
);
CREATE TABLE notification_settings(
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,company_id integer REFERENCES companies(id),code varchar(100) NOT NULL REFERENCES notification_templates(code),
 importance varchar(10) NOT NULL CHECK(importance IN('low','medium','high','critical')),enabled boolean NOT NULL,
 can_snooze boolean NOT NULL,allow_repeat boolean NOT NULL,repeat_interval varchar(10) NOT NULL CHECK(repeat_interval IN('none','day','week','month')),
 notify_managers boolean NOT NULL,notify_subject boolean NOT NULL,role_ids integer[] NOT NULL DEFAULT '{}',employee_ids integer[] NOT NULL DEFAULT '{}',
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),updated_by integer NOT NULL REFERENCES users(id),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE NULLS NOT DISTINCT(company_id,code),CHECK(allow_repeat OR repeat_interval='none'),CHECK(company_id IS NOT NULL OR (role_ids='{}' AND employee_ids='{}'))
);
CREATE TABLE notifications(
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,company_id integer REFERENCES companies(id),code varchar(100) NOT NULL REFERENCES notification_templates(code),
 recipient_user_id integer NOT NULL REFERENCES users(id),subject_employee_id integer,subject_key varchar(200) NOT NULL,event_key varchar(250) NOT NULL,
 title text NOT NULL,message text NOT NULL,importance varchar(10) NOT NULL CHECK(importance IN('low','medium','high','critical')),href text,
 assigned boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),read_at timestamptz,completed_at timestamptz,snoozed_until timestamptz,
 repeat_interval varchar(10) NOT NULL DEFAULT 'none' CHECK(repeat_interval IN('none','day','week','month')),next_reminder_at timestamptz,
 reminder_count integer NOT NULL DEFAULT 0 CHECK(reminder_count>=0),last_reminded_at timestamptz,revision integer NOT NULL DEFAULT 1 CHECK(revision>0),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,subject_employee_id) REFERENCES employees(company_id,id),
 UNIQUE NULLS NOT DISTINCT(company_id,event_key,recipient_user_id),
 CHECK(company_id IS NOT NULL OR subject_employee_id IS NULL),CHECK(completed_at IS NULL OR (next_reminder_at IS NULL AND snoozed_until IS NULL))
);
CREATE UNIQUE INDEX notifications_pending_reason ON notifications(COALESCE(company_id,0),code,recipient_user_id,subject_key) WHERE completed_at IS NULL;
CREATE INDEX notification_inbox ON notifications(recipient_user_id,company_id,created_at DESC,id);
CREATE INDEX notification_reminders ON notifications(next_reminder_at) WHERE completed_at IS NULL AND next_reminder_at IS NOT NULL;
CREATE FUNCTION protect_notification_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Notifications cannot be deleted' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-ARRAY['assigned','importance','read_at','completed_at','snoozed_until','repeat_interval','next_reminder_at','reminder_count','last_reminded_at','revision','updated_at']) IS DISTINCT FROM
 (to_jsonb(OLD)-ARRAY['assigned','importance','read_at','completed_at','snoozed_until','repeat_interval','next_reminder_at','reminder_count','last_reminded_at','revision','updated_at']) OR NEW.revision<>OLD.revision+1
 OR (OLD.completed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION 'Notification identity/history is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER notification_identity BEFORE UPDATE OR DELETE ON notifications FOR EACH ROW EXECUTE FUNCTION protect_notification_identity();
INSERT INTO notification_templates(code,name,category,scope,description,implemented,can_disable,default_importance,default_notify_managers) VALUES
('INVENTORY_NEGATIVE','مخزون صنف أصبح سالبًا','مخزون','company','عندما يصبح الرصيد التشغيلي للصنف سالبًا.',true,true,'medium',true),
('ITEM_EXPIRED','صنف تجاوز تاريخ الانتهاء','مخزون','company','دفعة لها رصيد وتجاوزت تاريخ انتهاء الصلاحية.',true,true,'medium',true),
('ITEM_EXPIRING_30','صنف سينتهي خلال 30 يومًا','مخزون','company','دفعة لها رصيد وينتهي تاريخها خلال ثلاثين يومًا.',true,true,'medium',true),
('ITEM_STOPPED','صنف توقف طلبه','مخزون','company','بلوغ تاريخ توقف طلب الصنف، بعد توفير هذا الحقل.',false,true,'medium',true),
('ITEM_STAGNANT_90','صنف راكد منذ 90 يومًا','مخزون','company','صنف له رصيد ولم يتحرك خلال تسعين يومًا.',false,true,'medium',true),
('LARGE_STOCK_ADJUSTMENT','تسوية جرد بفارق كبير','مخزون','company','تجاوز فرق الجرد الحد الذي سيحدده المدير؛ لا يوجد حد مفترض.',false,true,'medium',true),
('UNUSUAL_STOCK_MOVEMENT','حركة مخزون غير اعتيادية','مخزون','company','زيادة أو نقصان يتجاوز معيارًا سيحدد لاحقًا.',false,true,'medium',true),
('SALE_WITHOUT_ATTENDANCE','حفظ فاتورة مبيعات دون حضور','مبيعات','company','حفظ فاتورة مبيعات بواسطة موظف دون حضور مفتوح.',false,true,'medium',true),
('SALE_EXCEEDS_STOCK','بيع كمية أكثر من المخزون','مبيعات','company','بيع كمية أكبر من الرصيد المتاح للصنف.',false,true,'medium',true),
('PURCHASE_RETURN_EXCEEDS_STOCK','إرجاع مشتريات أكثر من المخزون','مبيعات','company','ترحيل مردود شراء يتجاوز المخزون المتاح.',false,true,'medium',true),
('LARGE_SALE_DISCOUNT','فاتورة مبيعات بخصم كبير','مبيعات','company','تجاوز نسبة الخصم ومبلغ الفاتورة حدودًا ستحدد لاحقًا.',false,true,'medium',true),
('HIGH_PURCHASE_PRICE','سعر شراء أعلى من الافتراضي','مبيعات','company','تجاوز سعر الشراء السعر المرجعي بحد سيحدد لاحقًا.',false,true,'medium',true),
('VOUCHER_EDITED','تعديل سند','محاسبة','company','تعديل سند مالي مع مرجع السند وسجل التغيير.',false,true,'medium',true),
('INVOICE_EDITED','تعديل فاتورة','مبيعات','company','تعديل فاتورة عندما تدعم دورة المستند ذلك.',false,true,'medium',true),
('RECORD_EDITED','تعديل سجل','نظام','company','تعديل نوع سجل يحدده المدير ضمن الأنواع المتابعة.',false,true,'medium',true),
('RECORD_DELETED','حذف سجل','نظام','company','حذف نوع سجل قابل للحذف ومحدد للمتابعة.',false,true,'medium',true),
('POSTED_INVOICE_EDIT_ATTEMPT','محاولة تعديل فاتورة مرحّلة','مبيعات','company','محاولة تعديل مستند مرحل محمي.',false,true,'high',true),
('INVOICE_CANCELLED','إلغاء فاتورة بعد اعتمادها','مبيعات','company','إلغاء مستند معتمد عندما تدعم دورة المستند ذلك.',false,true,'medium',true),
('CUSTOMER_CREDIT_LIMIT','عميل تجاوز حد الائتمان','محاسبة','company','تجاوز الحد الائتماني بعد توفير حدود ائتمان العملاء.',false,true,'medium',true),
('OVERDUE_INVOICE','فاتورة آجلة تجاوزت الاستحقاق','محاسبة','company','تجاوز تاريخ الاستحقاق مع وجود مبلغ غير مسدد.',false,true,'medium',true),
('LARGE_RECEIPT_VOUCHER','سند قبض بمبلغ كبير','محاسبة','company','تجاوز حد مبلغ يحدده المدير.',false,true,'medium',true),
('LARGE_PAYMENT_VOUCHER','سند صرف بمبلغ كبير','محاسبة','company','تجاوز حد مبلغ يحدده المدير.',false,true,'medium',true),
('ACCOUNT_MONTHLY_LIMIT','حساب تجاوز سقفه الشهري','محاسبة','company','تجاوز سقف محدد مع عدم وجود منع صارم.',false,true,'medium',true),
('ATTENDANCE_LATE','تأخر الموظف عن الدوام','موظفون','company','حضور الموظف بعد البداية المقررة بدقيقة كاملة أو أكثر.',true,true,'medium',true),
('ATTENDANCE_MISSED_30','عدم تسجيل الحضور بعد 30 دقيقة','موظفون','company','مرور ثلاثين دقيقة على بداية دوام محفوظ دون تسجيل حضور.',true,true,'medium',true),
('ATTENDANCE_ABSENT','غياب بعد نهاية الدوام','موظفون','company','انتهاء دوام محفوظ دون وجود حضور لهذا اليوم.',true,true,'high',true),
('ATTENDANCE_OPEN_16H','حضور تجاوز 16 ساعة دون انصراف','موظفون','company','مرور ست عشرة ساعة على حضور مفتوح دون انصراف.',true,true,'high',true),
('UNUSUAL_ATTENDANCE_IP','حضور من عنوان IP غير معتاد','أمان','company','تغير عنوان الحضور وفق سياسة موثوقة ستحدد لاحقًا.',false,true,'medium',true),
('UNUSUAL_ACCESS_IP','استخدام من عنوان IP غير معتاد','أمان','public','تغير عنوان الاستخدام وفق سياسة ستحدد لاحقًا.',false,true,'medium',false),
('SENSITIVE_ACTION_WITHOUT_ATTENDANCE','عملية حساسة دون حضور','أمان','company','محاولة إجراء حساس تحدده السياسة دون حضور.',false,true,'medium',true),
('EMPLOYEE_CONTRACT_END_30','اقتراب نهاية عقد موظف','موظفون','company','تبقي ثلاثين يومًا على عقد موظف بعد توفير بيانات العقود.',false,true,'medium',true),
('EMPLOYEE_LOAN_LIMIT','سلفة موظف تجاوزت الحد','موظفون','company','تجاوز حد سلفة معتمد بعد توفير دورة السلف.',false,true,'medium',true),
('AUTH_LOGIN_FAILED','محاولة تسجيل دخول فاشلة','أمان','public','فشل تسجيل دخول مع سياسة تجميع تمنع إغراق التنبيهات.',false,true,'medium',false),
('AUTH_NEW_DEVICE','دخول من جهاز أو متصفح جديد','أمان','public','دخول بجهاز لم يسبق اعتماده بعد توفير هوية الجهاز.',false,true,'medium',false),
('UNAUTHORIZED_ACCESS','محاولة الوصول دون صلاحية','أمان','company','رفض الوصول إلى إجراء أو بيانات داخل الشركة.',false,true,'medium',true),
('AUTH_PASSWORD_CHANGED','تغيير كلمة المرور','أمان','public','تغيير ناجح لكلمة مرور حسابك؛ دون حفظ كلمة المرور أو الجلسة.',true,false,'high',false),
('SENSITIVE_DATA_EDIT','محاولة تعديل بيانات حساسة','أمان','company','أنواع البيانات الحساسة ستحدد في مرحلة الربط.',false,true,'medium',true),
('SUSPICIOUS_SESSION','جلسة منتهية أو مشبوهة','أمان','public','رصد جلسة بحسب سياسة حماية محددة لاحقًا.',false,true,'medium',false),
('MEMO_RECEIVED','مذكرة جديدة إليك','مذكرات','company','استلام مذكرة موجهة إليك بعد بناء المذكرات.',false,true,'medium',true),
('MEMO_OVERDUE','مذكرة تجاوزت موعد التنفيذ','مذكرات','company','مذكرة غير منجزة تجاوزت موعدها.',false,true,'medium',true),
('MEMO_APPROVAL','مذكرة تحتاج اعتمادك','مذكرات','company','إحالة مذكرة إلى دور اعتمادك.',false,true,'medium',true),
('MEMO_REPLY','رد على مذكرة أرسلتها','مذكرات','company','رد جديد على مذكرة مرتبطة بك.',false,true,'medium',true),
('PUBLIC_SUGGESTION_REVIEW','اقتراح من الجمهور يحتاج مراجعة','دليل','public','اقتراح جديد ينتظر المراجعة بعد بناء الدليل.',false,true,'medium',false),
('COMMENT_REVIEW','تعليق يحتاج اعتمادًا','دليل','public','تعليق جديد ينتظر الاعتماد.',false,true,'medium',false),
('CONTENT_REPORT','بلاغ عن محتوى مسيء','دليل','public','بلاغ جديد لمراجعة المحتوى.',false,true,'medium',false),
('STORE_OWNERSHIP_VERIFIED','اكتمال توثيق ملكية متجر','دليل','public','اكتمال إجراء توثيق الملكية.',false,true,'medium',false),
('DOCUMENT_SAVE_FAILED','فشل حفظ مستند','نظام','company','خطأ حفظ بعد فصل تسجيل الخطأ عن المعاملة التي فشلت.',false,true,'medium',true),
('STORAGE_NEAR_FULL','اقتراب امتلاء التخزين','نظام','public','تجاوز حد تخزين سيحدد مع منصة الاستضافة.',false,true,'medium',false);
