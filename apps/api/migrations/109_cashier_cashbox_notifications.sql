-- Three separate, configurable company alert types for staff assigned the
-- "أمين صندوق" employee position. Managers are not included by default.
INSERT INTO notification_templates(
  code,name,category,scope,description,implemented,can_disable,
  default_importance,default_notify_managers
) VALUES
('CASHBOX_ELECTRONIC_TRANSFER','ترحيل إلى المحفظة الإلكترونية','الصندوق','company',
 'ترحيل مبلغ من صندوق المبيعات إلى المحفظة الإلكترونية، لأمناء الصناديق المحددين بكروت الموظفين.',true,true,'high',false),
('CASHBOX_POUCH_TRANSFER','ترحيل مبلغ إلى الحافظة','الصندوق','company',
 'ترحيل مبلغ من صندوق المبيعات إلى الحافظة أو إعادته، لأمناء الصناديق المحددين بكروت الموظفين.',true,true,'high',false),
('CASHBOX_CLOSED','إغلاق صندوق المبيعات','الصندوق','company',
 'إغلاق صندوق موظف وتسجيل النقد الفعلي والفرق، لأمناء الصناديق المحددين بكروت الموظفين.',true,true,'high',false)
ON CONFLICT(code) DO NOTHING;
