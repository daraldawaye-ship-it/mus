-- A purchase of an item with a currently stopped order, an empty/zero order
-- quantity and no "third-party goods" designation should be visible in the
-- company's notifications. Generated from posted invoices via durable followups.
INSERT INTO notification_templates
  (code, name, category, scope, description, implemented,
   can_disable, default_importance, default_notify_managers)
VALUES
  ('PURCHASE_STOPPED_ORDER',
   'تم شراء صنف متوقف طلبه',
   'مشتريات',
   'company',
   'تنبيه بعد ترحيل فاتورة مشتريات تحتوي على صنف متوقف طلبه، وكمية الطلب في كرت الصنف فارغة أو صفر، ولا يحمل تصنيف أصناف الغير.',
   true, true, 'high', true)
ON CONFLICT (code) DO UPDATE SET
  name=EXCLUDED.name,
  category=EXCLUDED.category,
  description=EXCLUDED.description,
  implemented=true;
