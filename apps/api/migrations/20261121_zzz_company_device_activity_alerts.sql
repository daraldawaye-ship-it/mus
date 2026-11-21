-- Nullable means never alerted; no scanning, notification, or backfill on deploy.
ALTER TABLE company_known_devices ADD COLUMN last_owner_activity_alert_at timestamptz;
INSERT INTO notification_templates
 (code,name,category,scope,description,implemented,can_disable,default_importance,
  default_notify_managers,default_min_interval_hours,default_latest_only)
VALUES ('COMPANY_EXTERNAL_DESKTOP_ACTIVITY','نشاط كمبيوتر غير مصنّف كجهاز الشركة','الأجهزة','company',
 'تنبيه داخل الموقع للمالك عند استخدام الشركة فعليًا من متصفح كمبيوتر غير مصنف «جهاز الشركة»، بحد أقصى تنبيه لكل جهاز في الساعة.',
 true,true,'medium',false,NULL,true)
ON CONFLICT (code) DO NOTHING;
