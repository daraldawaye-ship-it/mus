-- Split purchase corrections into independently configurable warnings.
-- A 3-day-old invoice is determined by its actual creation timestamp
-- (a full 72 hours), not by the editable document date.
INSERT INTO notification_templates
 (code,name,category,scope,description,implemented,can_disable,
  default_importance,default_notify_managers)
VALUES
 ('PURCHASE_TOTAL_CHANGED','تم تعديل اجمالي فاتورة مشتريات','مشتريات','company',
  'يصدر فقط إذا تغيّر صافي إجمالي الفاتورة بعد تصحيح المشتريات، ويعرض القيمة السابقة والجديدة والفارق.',true,true,'high',true),
 ('PURCHASE_OLD_CORRECTED','تم تعديل فاتورة مشتريات قديمه','مشتريات','company',
  'يصدر عند تصحيح فاتورة مشتريات مضى على إنشائها أكثر من 3 أيام كاملة (72 ساعة) لحظة اعتماد التصحيح.',true,true,'high',true)
ON CONFLICT (code) DO NOTHING;

-- Preserve the current recipients and opt-in policy for the new types on
-- their first creation. Afterward each notification type is independently
-- configurable, and an existing user's settings are not overwritten.
INSERT INTO notification_settings
 (company_id,code,importance,enabled,can_snooze,allow_repeat,repeat_interval,
  notify_managers,notify_subject,position_keys,employee_ids,updated_by,
  min_interval_hours,latest_only,notify_owner,reviewed)
SELECT s.company_id, new_type.code, s.importance, s.enabled, s.can_snooze,
       s.allow_repeat, s.repeat_interval, s.notify_managers, s.notify_subject,
       s.position_keys, s.employee_ids, s.updated_by, s.min_interval_hours,
       s.latest_only, s.notify_owner, false
FROM notification_settings s
CROSS JOIN (VALUES ('PURCHASE_TOTAL_CHANGED'),('PURCHASE_OLD_CORRECTED')) AS new_type(code)
WHERE s.code='PURCHASE_CORRECTED'
ON CONFLICT (company_id,code) DO NOTHING;
