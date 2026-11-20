INSERT INTO page_registry(key) VALUES ('public.ai-tasks') ON CONFLICT (key) DO NOTHING;

-- Keep legacy task IDs and journal links valid for existing operators.
CREATE TABLE ai_tasks (
  task_id integer PRIMARY KEY REFERENCES general_table(general_table_id) ON DELETE CASCADE,
  section text NOT NULL CHECK (length(btrim(section)) BETWEEN 1 AND 120),
  company_id integer REFERENCES companies(id),
  private_title varchar(200),
  private_description text,
  cadence_hours integer CHECK (cadence_hours BETWEEN 1 AND 8760),
  cadence_label text,
  archived_at timestamptz,
  previous_category varchar(120),
  previous_number2 numeric,
  CHECK (section <> 'الشركة' OR company_id IS NOT NULL)
);

INSERT INTO ai_tasks(task_id, section, company_id, cadence_hours, cadence_label, archived_at, previous_category, previous_number2)
SELECT general_table_id,
  CASE
    WHEN general_table_id IN (402, 429, 430, 431, 432) AND EXISTS (SELECT 1 FROM companies WHERE id=2) THEN 'الشركة'
    WHEN general_table_category LIKE 'سوق الأدوية%' OR general_table_id IN (441, 764) THEN 'السوق العام'
    WHEN general_table_id IN (401, 757) THEN 'إدارة الموقع'
    ELSE COALESCE(NULLIF(NULLIF(btrim(general_table_category), ''), 'الشركة'), 'غير محدد')
  END,
  CASE WHEN general_table_id IN (402,429,430,431,432) THEN (SELECT id FROM companies WHERE id=2) END,
  CASE
    WHEN general_table_id=902 THEN 2
    WHEN general_table_id IN (899,900,901) THEN 4
    WHEN general_table_id IN (403,414,415,416,417,418,419,420,421,422,423,424,425,426,427,428,429,430,474) THEN 5
    WHEN general_table_id IN (854,855) THEN 6
    WHEN general_table_id IN (402,432) THEN 20
  END,
  CASE
    WHEN general_table_id=401 THEN 'مرجع تشغيلي'
    WHEN general_table_id=442 THEN 'مرجع غير مفعّل'
    WHEN general_table_id=757 THEN 'مرة واحدة'
    WHEN general_table_id=764 THEN 'عند الطلب'
    WHEN general_table_id IN (399,400) OR general_table_id BETWEEN 433 AND 457 THEN 'معلّقة'
  END,
  CASE WHEN general_table_category='مهامك — مؤرشفة' THEN updated_at END,
  CASE WHEN general_table_id=431 THEN 'تراكيب دار الدواء' END,
  CASE WHEN general_table_id=431 THEN 0 END
FROM general_table
WHERE general_table_table_name='مهام الذكاء الاصطناعي';

CREATE FUNCTION register_ai_task() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.general_table_table_name='مهام الذكاء الاصطناعي' THEN
    INSERT INTO ai_tasks(task_id, section, cadence_hours, archived_at)
    VALUES (
      NEW.general_table_id,
      CASE WHEN NEW.general_table_category LIKE 'سوق الأدوية%' THEN 'السوق العام'
           ELSE COALESCE(NULLIF(NULLIF(btrim(NEW.general_table_category), ''), 'الشركة'), 'غير محدد') END,
      CASE WHEN NEW.general_table_category NOT IN ('الشركة','مهامك — مؤرشفة','مهامك — أفكار قيد المناقشة') THEN 8 END,
      CASE WHEN NEW.general_table_category='مهامك — مؤرشفة' THEN NEW.updated_at END
    ) ON CONFLICT (task_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER register_ai_task_after_insert
AFTER INSERT OR UPDATE OF general_table_table_name ON general_table
FOR EACH ROW EXECUTE FUNCTION register_ai_task();
