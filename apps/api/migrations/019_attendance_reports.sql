-- Existing schedules are known only from their last saved date; never invent earlier absences.
CREATE TABLE employee_schedule_history (
 company_id integer NOT NULL, employee_id integer NOT NULL, revision integer NOT NULL,
 effective_date date NOT NULL, branch_id integer NOT NULL, branch_name text NOT NULL,
 work_days smallint[] NOT NULL, start_time time NOT NULL, end_time time NOT NULL,
 active boolean NOT NULL, saved_at timestamptz NOT NULL, saved_by integer NOT NULL REFERENCES users(id),
 PRIMARY KEY(company_id,employee_id,revision),
 FOREIGN KEY(company_id,employee_id) REFERENCES employees(company_id,id),
 FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id)
);
CREATE INDEX schedule_history_day ON employee_schedule_history(company_id,employee_id,effective_date DESC,revision DESC);
INSERT INTO employee_schedule_history
 SELECT s.company_id,s.employee_id,s.revision,(s.updated_at AT TIME ZONE 'Asia/Aden')::date,
 s.branch_id,b.name,s.work_days,s.start_time,s.end_time,s.active,s.updated_at,s.updated_by
 FROM employee_schedules s JOIN branches b ON b.company_id=s.company_id AND b.id=s.branch_id;
CREATE FUNCTION capture_schedule_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO employee_schedule_history
 SELECT NEW.company_id,NEW.employee_id,NEW.revision,(NEW.updated_at AT TIME ZONE 'Asia/Aden')::date,
 NEW.branch_id,b.name,NEW.work_days,NEW.start_time,NEW.end_time,NEW.active,NEW.updated_at,NEW.updated_by
 FROM branches b WHERE b.company_id=NEW.company_id AND b.id=NEW.branch_id;
 RETURN NEW;
END $$;
CREATE TRIGGER schedule_history_capture AFTER INSERT OR UPDATE ON employee_schedules FOR EACH ROW EXECUTE FUNCTION capture_schedule_history();
CREATE FUNCTION protect_schedule_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Schedule history is immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER schedule_history_immutable BEFORE UPDATE OR DELETE ON employee_schedule_history FOR EACH ROW EXECUTE FUNCTION protect_schedule_history();
