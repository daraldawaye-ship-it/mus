-- Notify sales employees only when a posted sales return is for an item
-- with no positive sales in the preceding 3 or 30 days.
INSERT INTO notification_templates
 (code,name,category,scope,description,implemented,can_disable,
  default_importance,default_notify_managers,default_position_keys)
VALUES
 ('SALES_RETURN_NO_SALES_3D','إرجاع صنف بلا مبيعات خلال 3 أيام','مبيعات','company',
  'عند ترحيل مردود مبيعات لصنف لم تُسجل له مبيعات موجبة خلال الأيام الثلاثة السابقة للإرجاع، بشرط وجود بيع خلال آخر 30 يومًا. لا يرسل مع تنبيه الشهر لنفس الصنف والإرجاع.',
  true,true,'medium',false,'{sales}'::text[]),
 ('SALES_RETURN_NO_SALES_30D','إرجاع صنف بلا مبيعات خلال شهر','مبيعات','company',
  'عند ترحيل مردود مبيعات لصنف لم تُسجل له مبيعات موجبة خلال الثلاثين يومًا السابقة للإرجاع. يحل محل تنبيه الثلاثة أيام لنفس الصنف والإرجاع.',
  true,true,'medium',false,'{sales}'::text[])
ON CONFLICT (code) DO NOTHING;
