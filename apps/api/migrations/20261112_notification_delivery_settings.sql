ALTER TABLE notification_templates
  ADD COLUMN default_position_keys text[] NOT NULL DEFAULT '{}',
  ADD COLUMN default_latest_only boolean NOT NULL DEFAULT false;
ALTER TABLE notification_settings
  ADD COLUMN position_keys text[] NOT NULL DEFAULT '{}',
  ADD COLUMN min_interval_hours integer CHECK (min_interval_hours > 0),
  ADD COLUMN latest_only boolean;
ALTER TABLE notifications
  ADD COLUMN stream_key text NOT NULL DEFAULT '',
  ADD COLUMN silent_update boolean NOT NULL DEFAULT false,
  ADD COLUMN delivery_id integer REFERENCES notifications(id);
CREATE INDEX notification_silent_delivery ON notifications(delivery_id,id DESC) WHERE delivery_id IS NOT NULL;

-- Retain the active people previously selected via company roles.
UPDATE notification_settings s SET employee_ids=ARRAY(
  SELECT DISTINCT id FROM (
    SELECT unnest(s.employee_ids) AS id UNION ALL
    SELECT e.id FROM employee_role_assignments a
    JOIN company_roles r ON r.company_id=a.company_id AND r.id=a.role_id AND r.active
    JOIN employees e ON e.company_id=a.company_id AND e.id=a.employee_id AND e.active
    WHERE a.company_id=s.company_id AND a.active AND a.role_id=ANY(s.role_ids)
  ) recipients ORDER BY id
),role_ids='{}'
WHERE cardinality(role_ids)>0 AND code NOT IN ('CASHBOX_POUCH_TRANSFER','CASHBOX_CLOSED','CASHBOX_ELECTRONIC_TRANSFER');

UPDATE notification_templates t SET name=v.name,default_position_keys='{cashier}',
 default_latest_only=true,description='يُفحص عند حدوث العملية وكل ساعة. يظهر عدد العمليات التي ما زالت بانتظار الاستلام.'
FROM (VALUES ('CASHBOX_ELECTRONIC_TRANSFER','ترحيلات المحفظة الإلكترونية بانتظار الاستلام'),
 ('CASHBOX_POUCH_TRANSFER','ترحيلات الحافظة بانتظار الاستلام'),
 ('CASHBOX_CLOSED','إغلاقات الصندوق بانتظار الاستلام')) v(code,name)
WHERE t.code=v.code;
-- These three formerly had a hard cashier-only audience regardless of saved selectors.
UPDATE notification_settings SET position_keys='{cashier}',role_ids='{}',employee_ids='{}',notify_subject=false,notify_managers=false
 WHERE code IN ('CASHBOX_ELECTRONIC_TRANSFER','CASHBOX_POUCH_TRANSFER','CASHBOX_CLOSED');
UPDATE notification_templates SET default_latest_only=true WHERE code IN (
 'CHAT_DIRECT_COMPANY','CHAT_DIRECT_GLOBAL','CHAT_GROUP_GLOBAL','CHAT_GROUP_COMPANY',
 'QUICK_PRESENT_EMPLOYEES','QUICK_ALL_EMPLOYEES','QUICK_APP_MANAGER','QUICK_SYSTEM_CHANGE');
UPDATE notification_templates SET default_position_keys='{sales-supervisor}'
 WHERE code IN ('SALES_DOCTOR_REVIEW','SALES_ARCHIVED_DOCTOR_USED');
UPDATE notification_templates SET default_position_keys='{sales-supervisor,cashier}' WHERE code='ATTENDANCE_APPROVAL_REJECTED';

-- Backfill only the newly introduced grouping metadata, inside the migration transaction.
ALTER TABLE notifications DISABLE TRIGGER notification_identity;
UPDATE notifications n SET stream_key='sender:'||m.sender_id
 FROM chat_messages m WHERE n.code IN ('CHAT_DIRECT_GLOBAL','CHAT_DIRECT_COMPANY') AND n.subject_key='chat-message:'||m.id;
UPDATE notifications n SET stream_key='group:'||m.group_id||':sender:'||m.sender_id
 FROM chat_group_messages m WHERE n.code IN ('CHAT_GROUP_GLOBAL','CHAT_GROUP_COMPANY') AND n.subject_key='chat-group:'||m.group_id||':message:'||m.id;
UPDATE notifications SET stream_key='sender:'||split_part(subject_key,':',2)
 WHERE code IN ('QUICK_PRESENT_EMPLOYEES','QUICK_ALL_EMPLOYEES','QUICK_APP_MANAGER','QUICK_SYSTEM_CHANGE') AND subject_key LIKE 'quick:%';
ALTER TABLE notifications ENABLE TRIGGER notification_identity;
CREATE INDEX notification_stream_latest ON notifications (recipient_user_id,COALESCE(company_id,0),code,stream_key,id DESC);
CREATE INDEX notification_delivery_window ON notifications (recipient_user_id,COALESCE(company_id,0),code,created_at DESC) WHERE NOT silent_update;
CREATE TABLE cashbox_notification_scans (
 company_id integer PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
 checked_at timestamptz NOT NULL
);
