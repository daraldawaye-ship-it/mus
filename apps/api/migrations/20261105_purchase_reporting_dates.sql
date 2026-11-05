-- Reporting dates follow the first purchase in a correction chain. The posted
-- stock and journal records keep their chronology and immutable audit trail.
CREATE TABLE purchase_correction_dates (
  company_id integer NOT NULL,
  invoice_id integer NOT NULL,
  invoice_date date NOT NULL,
  PRIMARY KEY (company_id, invoice_id),
  FOREIGN KEY (company_id, invoice_id) REFERENCES invoices(company_id,id)
);

WITH RECURSIVE chain AS (
  SELECT c.company_id,c.reversal_id,c.replacement_id,i.document_date
  FROM purchase_invoice_corrections c
  JOIN invoices i ON (i.company_id,i.id)=(c.company_id,c.original_id)
  WHERE NOT EXISTS (SELECT 1 FROM purchase_invoice_corrections p
    WHERE (p.company_id,p.replacement_id)=(c.company_id,c.original_id))
  UNION ALL
  SELECT c.company_id,c.reversal_id,c.replacement_id,p.document_date
  FROM chain p JOIN purchase_invoice_corrections c
    ON (c.company_id,c.original_id)=(p.company_id,p.replacement_id)
)
INSERT INTO purchase_correction_dates
 SELECT company_id,unnest(ARRAY[reversal_id,replacement_id]),document_date FROM chain;

CREATE FUNCTION record_purchase_correction_dates() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO purchase_correction_dates
    SELECT NEW.company_id,unnest(ARRAY[NEW.reversal_id,NEW.replacement_id]),
      COALESCE(p.invoice_date,i.document_date)
    FROM invoices i LEFT JOIN purchase_correction_dates p
      ON (p.company_id,p.invoice_id)=(i.company_id,i.id)
    WHERE (i.company_id,i.id)=(NEW.company_id,NEW.original_id);
  RETURN NEW;
END $$;
CREATE TRIGGER purchase_correction_dates_after_insert AFTER INSERT ON purchase_invoice_corrections
  FOR EACH ROW EXECUTE FUNCTION record_purchase_correction_dates();

CREATE VIEW purchase_correction_journal_dates AS
  SELECT p.company_id,j.id AS document_id,p.invoice_date
  FROM purchase_correction_dates p JOIN invoices i
    ON (i.company_id,i.id)=(p.company_id,p.invoice_id)
  CROSS JOIN LATERAL unnest(ARRAY[i.financial_document_id,i.cost_document_id,i.variance_document_id]) j(id)
  WHERE j.id IS NOT NULL;
