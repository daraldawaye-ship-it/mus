-- Attendance earns points, with immutable sources and compensating adjustments.
ALTER TABLE attendance_records ADD CONSTRAINT attendance_records_company_id_id_key UNIQUE(company_id,id);
CREATE TABLE attendance_point_entries (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 company_id integer NOT NULL REFERENCES companies(id), employee_id integer NOT NULL,
 work_date date NOT NULL, attendance_record_id integer NOT NULL,
 kind varchar(12) NOT NULL CHECK(kind IN ('worked','punctual','adjustment')),
 points numeric(28,0) NOT NULL,
 eligible_microseconds bigint NOT NULL DEFAULT 0 CHECK(eligible_microseconds>=0),
 weighted_numerator numeric(60,0) NOT NULL DEFAULT 0 CHECK(weighted_numerator>=0),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
 idempotency_key uuid NOT NULL, request_payload jsonb NOT NULL,
 created_by integer NOT NULL REFERENCES users(id), created_by_name text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id), UNIQUE(company_id,idempotency_key),
 FOREIGN KEY(company_id,employee_id) REFERENCES employee_wallets(company_id,employee_id),
 FOREIGN KEY(company_id,attendance_record_id) REFERENCES attendance_records(company_id,id),
 CHECK((kind='worked' AND points>=0) OR
       (kind='punctual' AND points=50 AND eligible_microseconds=0 AND weighted_numerator=0) OR
       (kind='adjustment' AND points<>0 AND eligible_microseconds=0 AND weighted_numerator=0)),
 CHECK(jsonb_typeof(request_payload)='object')
);
CREATE UNIQUE INDEX attendance_work_points_once ON attendance_point_entries(company_id,attendance_record_id) WHERE kind='worked';
CREATE UNIQUE INDEX attendance_punctual_once ON attendance_point_entries(company_id,employee_id,work_date) WHERE kind='punctual';
CREATE INDEX attendance_points_daily ON attendance_point_entries(company_id,employee_id,work_date,id);
CREATE FUNCTION protect_attendance_points() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Attendance point sources are immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER attendance_points_immutable BEFORE UPDATE OR DELETE ON attendance_point_entries FOR EACH ROW EXECUTE FUNCTION protect_attendance_points();

ALTER TABLE employee_wallet_entries ADD attendance_entry_id integer,
 ADD FOREIGN KEY(company_id,attendance_entry_id) REFERENCES attendance_point_entries(company_id,id);
ALTER TABLE employee_wallet_entries DROP CONSTRAINT wallet_entry_kind_check;
ALTER TABLE employee_wallet_entries ADD CONSTRAINT wallet_entry_kind_check CHECK(kind IN ('manual','automatic','reversal','conversion','attendance'));
DO $$
DECLARE previous_check text;
BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO previous_check FROM pg_constraint
 WHERE conrelid='employee_wallet_entries'::regclass AND conname='wallet_entry_source_check';
 IF previous_check IS NULL THEN RAISE EXCEPTION 'Wallet source guard is missing'; END IF;
 ALTER TABLE employee_wallet_entries DROP CONSTRAINT wallet_entry_source_check;
 EXECUTE format('ALTER TABLE employee_wallet_entries ADD CONSTRAINT wallet_entry_source_check CHECK (
 (attendance_entry_id IS NULL AND (%s)) OR
 (kind=''attendance'' AND points<>0 AND money=0 AND attendance_entry_id IS NOT NULL AND reference_id IS NULL
  AND invoice_id IS NULL AND financial_document_id IS NULL AND conversion_id IS NULL
  AND page_key IS NULL AND task_code IS NULL AND task_revision IS NULL AND logical_line_count IS NULL))',previous_check);
END $$;
CREATE UNIQUE INDEX wallet_attendance_source_once ON employee_wallet_entries(company_id,attendance_entry_id) WHERE attendance_entry_id IS NOT NULL;

CREATE FUNCTION check_attendance_point_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r attendance_records; ledger employee_wallet_entries;
BEGIN
 SELECT * INTO r FROM attendance_records WHERE company_id=NEW.company_id AND id=NEW.attendance_record_id;
 IF NOT FOUND OR r.employee_id<>NEW.employee_id OR r.work_date<>NEW.work_date THEN
  RAISE EXCEPTION 'Attendance points must identify their scoped attendance record' USING ERRCODE='23514';
 END IF;
 IF NEW.kind='worked' AND (r.checked_out_at IS NULL OR r.needs_review) THEN
  RAISE EXCEPTION 'Unclosed or automatic-review attendance cannot earn worked points' USING ERRCODE='23514';
 END IF;
 SELECT * INTO ledger FROM employee_wallet_entries WHERE company_id=NEW.company_id AND attendance_entry_id=NEW.id;
 IF NEW.points<>0 AND (NOT FOUND OR ledger.kind<>'attendance' OR ledger.employee_id<>NEW.employee_id OR ledger.points<>NEW.points OR ledger.created_by<>NEW.created_by) THEN
  RAISE EXCEPTION 'Attendance points need their exact wallet posting' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER attendance_point_source AFTER INSERT ON attendance_point_entries
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_attendance_point_source();
CREATE FUNCTION check_wallet_attendance_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source attendance_point_entries;
BEGIN
 IF NEW.kind='attendance' THEN
  SELECT * INTO source FROM attendance_point_entries WHERE company_id=NEW.company_id AND id=NEW.attendance_entry_id;
  IF NOT FOUND OR source.employee_id<>NEW.employee_id OR source.points<>NEW.points OR source.created_by<>NEW.created_by THEN
   RAISE EXCEPTION 'Wallet attendance entry must match its immutable source' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER wallet_attendance_source AFTER INSERT ON employee_wallet_entries
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_wallet_attendance_source();

UPDATE notification_templates SET description='حضور بعد الوقت المتوقع بأكثر من عشر دقائق؛ وقت الحضور مرجع اختياري ولا يمنع التسجيل.' WHERE code='ATTENDANCE_LATE';
UPDATE notification_templates SET description='انصراف آلي عند مرور 16 ساعة على حضور مفتوح؛ السجل يحتاج مراجعة وتتم المعالجة بتعويض أو خصم مستقل.' WHERE code='ATTENDANCE_OPEN_16H';
