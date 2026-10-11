# الجدول العام General Table

جدول عام قابل لإعادة الاستخدام في **نطاق إدارة الموقع**. لا تشارك البيانات تلقائيًا مع الجمهور أو مع أي شركة. يستطيع المالك أو مستخدم من نوع إدارة تصفح السجلات وإضافتها وتعديلها من المسار `/general-table`.

- `general_table_id`: رقم تلقائي (مفتاح أساسي)
- `general_table_table_name`: اسم الاستخدام أو المجموعة المنطقية (إلزامي؛ مثال `shops`)
- `general_table_category`: تصنيف داخلي اختياري
- `general_table_title`: عنوان السجل (إلزامي)
- `general_table_description`: وصف طويل
- `general_table_number1` و`general_table_number2`: قيم رقمية عشرية اختيارية محفوظة بدقة PostgreSQL NUMERIC
- `general_table_date1` و`general_table_date2`: تاريخ ووقت اختياريان بصيغة timestamptz
- `general_table_text1` حتى `general_table_text9`: حقول نصية طويلة
- بيانات التتبع: `created_by`, `created_at`, `updated_at`

API: `GET /api/general-table`, `GET /api/general-table/:id`, `POST /api/general-table`, `PATCH /api/general-table/:id`.

تدعم القائمة البحث `q` والتصفية الدقيقة `tableName` و`category` وترتيب النتائج والصفحات. التعديلات ضمن معاملة قاعدة بيانات وتُسجّل في سجل التدقيق. لا يوجد حذف نهائي حاليًا لحماية البيانات التي قد تُربط لاحقًا.

**مهم:** هذا جدول بيانات عام وليس بديلاً آليًا عن جداول العمليات المالية أو حركات المخزون ذات العلاقات والقيود المتخصصة. تحديد معنى أي حقل خاص بكل استخدام يتم عند طلب إنشاء الوحدة المرتبطة به لاحقًا.
