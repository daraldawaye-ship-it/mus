-- Pending inquiries are reminders to their assigned recipient, not broadcasts.
-- A durable per-user signature prevents repeated alerts for an unchanged queue.
INSERT INTO notification_templates
 (code,name,category,scope,description,implemented,can_disable,default_importance,default_notify_managers,default_latest_only)
VALUES
 ('INQUIRY_UNANSWERED_COMPANY','وجود استفسارات بدون جواب','استفسارات','company',
  'تنبيه للمستخدم عن استفسارات الشركة الموجهة إليه وما زالت تنتظر إجابته. يتحدث عند تغيرها ويختفي عند اكتمالها.',true,true,'medium',false,true),
 ('INQUIRY_UNANSWERED_PUBLIC','وجود استفسارات بدون جواب','استفسارات','public',
  'تنبيه للمستخدم عن الاستفسارات العامة الموجهة إليه وما زالت تنتظر إجابته. يتحدث عند تغيرها ويختفي عند اكتمالها.',true,true,'medium',false,true)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE inquiry_notification_state (
 scope_key integer NOT NULL CHECK (scope_key >= 0),
 user_id integer NOT NULL REFERENCES users(id),
 signature text NOT NULL DEFAULT '',
 generation bigint NOT NULL DEFAULT 0,
 PRIMARY KEY (scope_key,user_id)
);

CREATE TABLE inquiry_notification_scans (
 scope_key integer PRIMARY KEY CHECK (scope_key >= 0),
 checked_at timestamptz NOT NULL
);
