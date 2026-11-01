-- Company item-clearance changes must notify configured followers, without
-- slowing the item-card PATCH or changing current invoice/earning snapshots.
INSERT INTO notification_templates
 (code,name,category,scope,description,implemented,can_disable,
  default_importance,default_notify_managers)
VALUES
 ('ITEM_CLEARANCE_ADDED','إضافة صنف إلى التصريف','مبيعات','company',
  'أصبح الصنف مشمولاً بعمولة التصريف بعد تغيير النسبة أو فترة التصريف.',
  true,true,'medium',true),
 ('ITEM_CLEARANCE_UPDATED','تعديل تصريف صنف','مبيعات','company',
  'تغيّرت نسبة عمولة التصريف أو تاريخ البداية أو النهاية للصنف.',
  true,true,'medium',true),
 ('ITEM_CLEARANCE_REMOVED','إخراج صنف من التصريف','مبيعات','company',
  'أُلغيت أو انتهت أهلية صنف للتصريف بسبب تعديل إعداداته.',
  true,true,'medium',true)
ON CONFLICT(code) DO NOTHING;

-- Small transactional outbox; the asynchronous worker emits through the
-- existing notification templates/follower permissions after item PATCH commits.
CREATE TABLE item_clearance_notification_jobs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer NOT NULL,
  item_id integer NOT NULL,
  item_revision integer NOT NULL CHECK(item_revision > 0),
  notification_code varchar(48) NOT NULL
    CHECK(notification_code IN
      ('ITEM_CLEARANCE_ADDED','ITEM_CLEARANCE_UPDATED','ITEM_CLEARANCE_REMOVED')),
  title text NOT NULL,
  message text NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_error_code varchar(64),
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(company_id,item_id,item_revision)
);
CREATE INDEX item_clearance_notification_jobs_pending
  ON item_clearance_notification_jobs(next_attempt_at,id)
  WHERE processed_at IS NULL;
