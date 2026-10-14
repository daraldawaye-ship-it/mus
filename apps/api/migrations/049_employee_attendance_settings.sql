-- Explicit employee attendance preferences; no rate or schedule is inferred.
CREATE TABLE employee_attendance_settings (
  company_id integer NOT NULL REFERENCES companies(id),
  employee_id integer NOT NULL,
  hourly_points numeric(9,0) CHECK(hourly_points BETWEEN 0 AND 999999999),
  default_daily_hours numeric(4,2) CHECK(default_daily_hours BETWEEN 0.01 AND 24),
  expected_start_time time,
  allow_overtime boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  created_by integer NOT NULL REFERENCES users(id),
  updated_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,employee_id),
  FOREIGN KEY(company_id,employee_id) REFERENCES employees(company_id,id),
  CHECK(hourly_points IS NULL OR hourly_points=0 OR default_daily_hours IS NOT NULL),
  CHECK(expected_start_time IS NULL OR expected_start_time<time '24:00:00'),
  CHECK(expected_start_time IS NULL OR EXTRACT(SECOND FROM expected_start_time)=0)
);

CREATE FUNCTION protect_employee_attendance_settings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Attendance settings cannot be deleted' USING ERRCODE='23514';
  END IF;
  IF ROW(NEW.company_id,NEW.employee_id,NEW.created_by,NEW.created_at)
     IS DISTINCT FROM ROW(OLD.company_id,OLD.employee_id,OLD.created_by,OLD.created_at)
     OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at THEN
    RAISE EXCEPTION 'Attendance settings identity is immutable and revision must advance' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER employee_attendance_settings_identity BEFORE UPDATE OR DELETE
  ON employee_attendance_settings FOR EACH ROW EXECUTE FUNCTION protect_employee_attendance_settings();

-- Keep the system option descriptive in the shared directory. Its value is
-- always read from the attendance settings table rather than option_values.
DO $$
DECLARE existing record;
BEGIN
  FOR existing IN SELECT conname FROM pg_constraint
    WHERE conrelid='option_definitions'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%native_binding%'
  LOOP EXECUTE format('ALTER TABLE option_definitions DROP CONSTRAINT %I',existing.conname); END LOOP;
END $$;
ALTER TABLE option_definitions ADD CONSTRAINT option_definitions_native_binding_known
  CHECK(native_binding IS NULL OR (is_system AND value_type='boolean' AND (
    (record_kind='item' AND native_binding IN ('items.archived','items.has_expiry')) OR
    (record_kind='account' AND native_binding='accounts.archived') OR
    (record_kind='employee' AND native_binding='employee.attendanceAllowOvertime'))));

CREATE FUNCTION seed_employee_attendance_option(target_company integer,actor_id integer)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE seeded jsonb;
BEGIN
  WITH added AS (
    INSERT INTO option_definitions
      (company_id,key,page_key,record_kind,name,description,value_type,default_value,
       searchable,is_system,native_binding,sort_order,created_by,updated_by)
    VALUES(target_company,'employees.attendance-allow-overtime','company.employees','employee',
      'قابل للدوام فوق دوامه الافتراضي',
      'السماح باحتساب ساعات تتجاوز الساعات اليومية الافتراضية؛ يُضبط من إعدادات دوام الموظف.',
      'boolean','false',true,true,'employee.attendanceAllowOvertime',40,actor_id,actor_id)
    ON CONFLICT(company_id,key) DO NOTHING RETURNING *
  ) SELECT jsonb_agg(to_jsonb(added)) INTO seeded FROM added;
  IF seeded IS NOT NULL THEN
    INSERT INTO audit_events(actor_id,actor_name,scope,company_id,action,target_type,target_id,before_value,after_value)
    VALUES(NULL,'النظام','company',target_company,'configuration.options.seed','company',target_company,NULL,seeded);
  END IF;
END $$;
SELECT seed_employee_attendance_option(id,created_by) FROM companies;
CREATE FUNCTION seed_new_company_attendance_option() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM seed_employee_attendance_option(NEW.id,NEW.created_by); RETURN NEW; END $$;
CREATE TRIGGER companies_attendance_option_default AFTER INSERT ON companies
  FOR EACH ROW EXECUTE FUNCTION seed_new_company_attendance_option();
