-- Identify the source task of each inquiry without changing its question or replies.
ALTER TABLE inquiry_requests
  ADD COLUMN IF NOT EXISTS task_name varchar(200) NOT NULL DEFAULT '';

-- Legacy invoice follow-ups from AI task #402 are the only historical cases
-- that can be confidently attributed based on their source and wording.
UPDATE inquiry_requests
SET task_name = 'متابعة ملحقات الامبولات والمحاليل'
WHERE company_id = 2
  AND linked_table = 'invoices'
  AND task_name = ''
  AND request_text LIKE 'متابعة فاتورة المبيعات رقم %'
  AND (request_text ILIKE '%سرنج%'
    OR request_text ILIKE '%سيرنج%'
    OR request_text ILIKE '%إبرة%'
    OR request_text ILIKE '%ابرة%'
    OR request_text ILIKE '%IV Set%'
    OR request_text ILIKE '%موصل%'
    OR request_text ILIKE '%تسريب وريدي%');
