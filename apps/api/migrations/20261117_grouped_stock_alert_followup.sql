-- One aggregate monitoring cadence per company and notification type.
-- A NULL min_interval_hours on the notification card means one hour for
-- these three monitors only. Other notification families are unaffected.
CREATE TABLE stock_alert_group_scans (
  company_id integer NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code text NOT NULL CHECK (code IN ('ITEM_ORDER_LEVEL','ITEM_EXPIRED','ITEM_EXPIRING_30')),
  checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (company_id,code)
);

INSERT INTO page_registry(key)
VALUES ('company.expired-items-follow-up'),
       ('company.expiring-items-follow-up')
ON CONFLICT(key) DO NOTHING;

UPDATE notification_templates
SET description='فحص إجمالي الأصناف الواقعة عند حد الطلب أو دونه وإرسال تنبيه إجمالي حسب عدد الساعات المحدد في كرت النوع، مع رابط صفحة المتابعة.'
WHERE code='ITEM_ORDER_LEVEL';

UPDATE notification_templates
SET description='فحص الدفعات المنتهية ذات الرصيد الموجب وإرسال تنبيه إجمالي حسب عدد الساعات المحدد في كرت النوع، مع رابط صفحة المتابعة.'
WHERE code='ITEM_EXPIRED';

UPDATE notification_templates
SET description='فحص الدفعات ذات الرصيد الموجب التي ستنتهي من اليوم إلى 30 يومًا وإرسال تنبيه إجمالي حسب عدد الساعات المحدد في كرت النوع.'
WHERE code='ITEM_EXPIRING_30';
