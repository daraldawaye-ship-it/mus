-- Separate immutable requests/decisions from the protected attendance history.
-- Check-in is not a recorded attendance until another pharmacy-device user approves.
-- Check-out is recorded immediately; its approval is for accountability only.
CREATE TABLE attendance_punch_approvals (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  employee_id INTEGER NOT NULL,
  requester_user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('check-in','check-out')),
  record_id INTEGER REFERENCES attendance_records(id),
  idempotency_key UUID,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  work_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by INTEGER REFERENCES users(id),
  decided_at TIMESTAMPTZ,
  decision_device_id BIGINT REFERENCES company_known_devices(id),
  FOREIGN KEY(company_id,employee_id) REFERENCES employees(company_id,id),
  CHECK ((status='pending' AND decided_by IS NULL AND decided_at IS NULL AND decision_device_id IS NULL)
      OR (status<>'pending' AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND decision_device_id IS NOT NULL)),
  CHECK (kind='check-out' OR status='approved' OR record_id IS NULL),
  CHECK (kind='check-in' OR record_id IS NOT NULL),
  UNIQUE(company_id,employee_id,kind,idempotency_key)
);
CREATE UNIQUE INDEX attendance_one_pending_checkin ON attendance_punch_approvals(company_id,employee_id)
  WHERE kind='check-in' AND status='pending';
CREATE UNIQUE INDEX attendance_one_checkout_approval ON attendance_punch_approvals(company_id,record_id)
  WHERE kind='check-out';
CREATE INDEX attendance_punch_pending_company ON attendance_punch_approvals(company_id,requested_at,id)
  WHERE status='pending';
CREATE INDEX attendance_punch_record ON attendance_punch_approvals(company_id,record_id,kind);

INSERT INTO notification_templates(code,name,category,scope,description,implemented,can_disable,default_importance,default_notify_managers)
VALUES ('ATTENDANCE_APPROVAL_REJECTED','رفض مصادقة حضور أو انصراف','موظفون','company',
        'إخطار المالك ومشرف المبيعات وأمين الصندوق عند رفض مصادقة الحضور أو الانصراف.',true,false,'high',true)
ON CONFLICT(code) DO NOTHING;
