-- An archived doctor/entity used on a new sale reuses its existing card,
-- while notifying its reviewers without silently reactivating it.
INSERT INTO notification_templates
  (code,name,category,scope,description,implemented,can_disable,
   default_importance,default_notify_managers)
VALUES
  ('SALES_ARCHIVED_DOCTOR_USED',
   'استخدام طبيب أو جهة مؤرشفة في المبيعات','مبيعات','company',
   'استخدام اسم طبيب أو جهة مؤرشفة عند حفظ فاتورة مبيعات دون إنشاء كرت آخر أو إعادة تفعيله.',
   true,true,'medium',false)
ON CONFLICT (code) DO NOTHING;
