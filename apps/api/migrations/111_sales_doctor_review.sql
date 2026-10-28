-- Names entered at sales checkout become real doctor-directory cards without classification.
-- Existing doctor, nurse and entity cards remain untouched.
ALTER TABLE doctors ALTER COLUMN kind DROP NOT NULL;
CREATE INDEX doctors_unclassified_review
  ON doctors(company_id,id) WHERE kind IS NULL AND active;

INSERT INTO notification_templates
 (code,name,category,scope,description,implemented,can_disable,
  default_importance,default_notify_managers)
VALUES
 ('SALES_DOCTOR_REVIEW','اسم طبيب أو جهة جديد يحتاج مراجعة','مبيعات','company',
  'اسم جديد أُضيف تلقائيًا إلى كرت الأطباء والجهات عند حفظ فاتورة مبيعات؛ حدّد الفئة والتفاصيل أو أرشف الكرت.',
  true,true,'medium',false)
ON CONFLICT(code) DO NOTHING;
