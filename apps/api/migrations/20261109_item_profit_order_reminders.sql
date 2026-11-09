
-- Separate the new reminder threshold from the legacy planned order quantity:
-- historical order_quantity values must never activate reminders accidentally.
ALTER TABLE items
  ADD COLUMN default_profit_factor numeric(10,4) NOT NULL DEFAULT 1.2000
    CHECK (default_profit_factor >= 1),
  ADD COLUMN order_alert_quantity numeric(22,0)
    CHECK (order_alert_quantity IS NULL OR order_alert_quantity >= 0);

-- Reads and daily scans only evaluate explicitly configured alert quantities.
CREATE INDEX items_order_alert_configured
  ON items(company_id,id) WHERE active AND order_alert_quantity IS NOT NULL;

INSERT INTO notification_templates
(code,name,category,scope,description,implemented,can_disable,default_importance,default_notify_managers)
VALUES ('ITEM_ORDER_LEVEL','تذكير كمية الطلب','مخزون','company',
  'تذكير يومي للمالك والمبيعات عندما يصبح المتوفر في المعرض والمخازن غير المرتجعة بالوحدة الأولى مساوياً لكمية الطلب أو أقل.',
  true,false,'medium',false)
ON CONFLICT (code) DO NOTHING;

-- A committed scan and its notifications are one transaction; one per company/day.
CREATE TABLE item_order_reminder_days (
  company_id integer NOT NULL REFERENCES companies(id),
  scan_day date NOT NULL,
  scanned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  matches integer NOT NULL DEFAULT 0 CHECK(matches>=0),
  PRIMARY KEY (company_id,scan_day)
);
