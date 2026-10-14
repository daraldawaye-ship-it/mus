-- Keep real punches and historical snapshots; allow multiple sessions per calendar day.
ALTER TABLE attendance_records DROP CONSTRAINT attendance_records_company_id_employee_id_work_date_key;
ALTER TABLE attendance_records ALTER branch_id DROP NOT NULL,ALTER branch_name DROP NOT NULL,
 ALTER start_time DROP NOT NULL,ALTER end_time DROP NOT NULL,ALTER schedule_revision DROP NOT NULL;
ALTER TABLE attendance_records
 ADD hourly_points numeric(9,0) CHECK(hourly_points>=0),
 ADD default_daily_hours numeric(4,2) CHECK(default_daily_hours BETWEEN 0.01 AND 24),
 ADD expected_start_time time,
 ADD allow_overtime boolean NOT NULL DEFAULT false,
 ADD settings_revision integer CHECK(settings_revision>0),
 ADD close_source varchar(12) CHECK(close_source IN ('manual','automatic')),
 ADD needs_review boolean NOT NULL DEFAULT false,
 ADD CHECK(hourly_points IS NULL OR hourly_points=0 OR default_daily_hours IS NOT NULL),
 ADD CONSTRAINT attendance_close_source_check CHECK(
  (checked_out_at IS NULL AND close_source IS NULL AND NOT needs_review)
  OR (checked_out_at IS NOT NULL AND ((close_source IS NULL AND NOT needs_review)
   OR (close_source='manual' AND NOT needs_review)
   OR (close_source='automatic' AND needs_review AND checked_out_at=checked_in_at+interval '16 hours'))));
CREATE INDEX attendance_daily_sessions ON attendance_records(company_id,employee_id,work_date,checked_in_at,id);
CREATE TABLE attendance_day_policies (
 company_id integer NOT NULL REFERENCES companies(id),employee_id integer NOT NULL,work_date date NOT NULL,
 default_daily_hours numeric(4,2) NOT NULL CHECK(default_daily_hours BETWEEN 0.01 AND 24),allow_overtime boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(company_id,employee_id,work_date),
 FOREIGN KEY(company_id,employee_id) REFERENCES employees(company_id,id)
);
CREATE FUNCTION protect_attendance_day_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'A day attendance cap is an immutable snapshot' USING ERRCODE='23514'; END $$;
CREATE TRIGGER attendance_day_policy_immutable BEFORE UPDATE OR DELETE ON attendance_day_policies
 FOR EACH ROW EXECUTE FUNCTION protect_attendance_day_policy();
CREATE OR REPLACE FUNCTION protect_attendance_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Attendance records cannot be deleted' USING ERRCODE='23514'; END IF;
 IF OLD.checked_out_at IS NOT NULL OR NEW.checked_out_at IS NULL OR NEW.close_source IS NULL
   OR (to_jsonb(NEW)-ARRAY['checked_out_at','close_source','needs_review','revision','updated_by','updated_at']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['checked_out_at','close_source','needs_review','revision','updated_by','updated_at'])
   OR NEW.revision<>OLD.revision+1 THEN
  RAISE EXCEPTION 'Attendance history can only be closed once; punch and policy snapshots are immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
-- Flexible days do not define absence, rest days or fixed-shift missing attendance.
-- Old notification history remains intact; the worker stops producing these types.
UPDATE notification_templates SET implemented=false,
 description='متوقف في الحضور المرن؛ لا يستنتج غياب أو حضور متأخر دون سياسة أيام وإجازات معتمدة.'
 WHERE code IN ('ATTENDANCE_MISSED_30','ATTENDANCE_ABSENT');
