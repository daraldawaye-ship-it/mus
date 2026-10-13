INSERT INTO page_registry(key) VALUES('company.attendance');
INSERT INTO permission_definitions(key,page_key,action,name,rule_role,required_permissions) VALUES
('company.attendance:view','company.attendance','view','الحضور والانصراف — عرض','company-member','{}'),
('company.attendance:create','company.attendance','create','الحضور والانصراف — تسجيل','company-member','{}'),
('company.attendance:edit','company.attendance','edit','الحضور والانصراف — إعداد الدوام','company-general','{}');
CREATE TABLE employee_schedules (
 company_id integer NOT NULL REFERENCES companies(id),employee_id integer NOT NULL,
 branch_id integer NOT NULL,work_days smallint[] NOT NULL CHECK(cardinality(work_days) BETWEEN 1 AND 7 AND work_days<@ARRAY[0,1,2,3,4,5,6]::smallint[] AND array_position(work_days,NULL) IS NULL),
 start_time time NOT NULL,end_time time NOT NULL CHECK(end_time<>start_time),active boolean NOT NULL DEFAULT true,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),updated_by integer NOT NULL REFERENCES users(id),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id,employee_id),
 FOREIGN KEY(company_id,employee_id) REFERENCES employees(company_id,id),
 FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id)
);
CREATE TABLE attendance_records (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,company_id integer NOT NULL REFERENCES companies(id),employee_id integer NOT NULL,
 employee_name text NOT NULL,branch_id integer NOT NULL,branch_name text NOT NULL,
 work_date date NOT NULL,checked_in_at timestamptz NOT NULL,checked_out_at timestamptz,
 start_time time NOT NULL,end_time time NOT NULL,schedule_revision integer NOT NULL,
 idempotency_key uuid NOT NULL,created_by integer NOT NULL REFERENCES users(id),updated_by integer NOT NULL REFERENCES users(id),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,employee_id) REFERENCES employees(company_id,id),FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id),
 UNIQUE(company_id,employee_id,work_date),UNIQUE(company_id,employee_id,idempotency_key),
 CHECK(checked_out_at IS NULL OR checked_out_at>=checked_in_at)
);
CREATE UNIQUE INDEX attendance_one_open ON attendance_records(company_id,employee_id) WHERE checked_out_at IS NULL;
CREATE INDEX attendance_listing ON attendance_records(company_id,work_date DESC,employee_id,id);
CREATE FUNCTION protect_attendance_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Attendance records cannot be deleted' USING ERRCODE='23514'; END IF;
 IF OLD.checked_out_at IS NOT NULL OR NEW.checked_out_at IS NULL
   OR (to_jsonb(NEW)-ARRAY['checked_out_at','revision','updated_by','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['checked_out_at','revision','updated_by','updated_at'])
   OR NEW.revision<>OLD.revision+1 THEN
   RAISE EXCEPTION 'Attendance history can only be closed once' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER attendance_history BEFORE UPDATE OR DELETE ON attendance_records FOR EACH ROW EXECUTE FUNCTION protect_attendance_history();
CREATE FUNCTION protect_schedule_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.company_id,NEW.employee_id) IS DISTINCT FROM ROW(OLD.company_id,OLD.employee_id) OR NEW.revision<>OLD.revision+1 THEN
   RAISE EXCEPTION 'Schedule identity is immutable and revision must advance' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER schedule_identity BEFORE UPDATE ON employee_schedules FOR EACH ROW EXECUTE FUNCTION protect_schedule_identity();
