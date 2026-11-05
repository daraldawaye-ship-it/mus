CREATE TABLE purchase_invoice_corrections (
 company_id integer NOT NULL,
 original_id integer NOT NULL,
 reversal_id integer NOT NULL,
 replacement_id integer NOT NULL,
 actor_id integer NOT NULL REFERENCES users(id),
 actor_name text NOT NULL,
 corrected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 500),
 before_invoice jsonb NOT NULL,
 after_invoice jsonb NOT NULL,
 impact jsonb NOT NULL,
 request_hash text NOT NULL,
 PRIMARY KEY(company_id,original_id),
 UNIQUE(company_id,reversal_id),
 UNIQUE(company_id,replacement_id),
 FOREIGN KEY(company_id,original_id) REFERENCES invoices(company_id,id),
 FOREIGN KEY(company_id,reversal_id) REFERENCES invoices(company_id,id),
 FOREIGN KEY(company_id,replacement_id) REFERENCES invoices(company_id,id)
);
CREATE FUNCTION protect_purchase_correction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Purchase correction history is immutable'; END $$;
CREATE TRIGGER immutable_purchase_correction BEFORE UPDATE OR DELETE ON purchase_invoice_corrections
 FOR EACH ROW EXECUTE FUNCTION protect_purchase_correction();
INSERT INTO notification_templates(code,name,category,scope,description,implemented,can_disable,default_importance,default_notify_managers)
 VALUES ('PURCHASE_CORRECTED','تم تعديل فاتورة مشتريات','مشتريات','company','تفاصيل تصحيح فاتورة المشتريات وموظف الاعتماد',true,false,'high',true);
