# إدارة قضايا مصطفى — النظام المترابط (24 أكتوبر 2026)

## المجال والملكية
- النظام ضمن «الموقع العام» في الرئيسي، وليس ضمن شركة «صيدلية دار الدواء» أو أي شركة.
- عام يعني موضع القائمة فقط؛ عرض وإضافة وتعديل جميع القضايا لمالك المنصة فقط حاليًا، بما في ذلك جميع واجهات API والصور والتصدير للذكاء الاصطناعي. منح صلاحيات legal_case_access للآخرين مغلق، ولا تمنح السجلات السابقة أي وصول إلى أن يسمح المالك ويُعدل النظام صراحة.
- التطبيق متصل بمستودع daraldawaye-ship-it/mus وفرع الإنتاج الحالي preview/render-2026-10-23 على Render. لا تُنشر التعديلات إلى Railway.

## مصدر البيانات
- migration 118 تنشئ جداول جديدة، وتحفظ السجلات القديمة كما هي في general_table.
- سجلات «قضايا مصطفى» تُحفظ في legal_cases مع legacy_general_id وlegacy_snapshot (نسخة من جميع حقول الأصل).
- سجلات «معطيات في قضية مصطفى»، «مستندات قضايا مصطفى»، «مهام في قضايا مصطفى» تنسخ إلى legal_records كـ fact/document/task وتظل غير مرتبطة آليًا بقضية إذا لم تُتحقق الصلة. الربط يدوي/مراجع.
- القضايا المستوردة تتلقى status=unknown وneeds_review=true لتجنب تعيين المرحلة أو الحالة بغير دليل. عند إكمال المراجعة تُحدث حقولها.
- لا تعدّل نسخ الجداول العامة أثناء النقل ولا تعيد الاستيراد بحذف البيانات.

## مخطط العلاقات
- legal_cases: الحالة، رقم القضية، الجهة، المرحلة، تاريخ البداية والجلسة القادمة، حالة صورة الملف، الأولوية، Drive folder ID/URL، الوصف، المصدر القديم.
- legal_records: kind= fact / document / event / explanation / task / report / hearing، مع عنوان، شرح body، محتوى المستند النصي content_text، صور image_urls + legal_document_images، pdf_url، drive_file_id وdrive_folder_id وdrive_folder_url، رقم المستند والجهة، تاريخ الحدث والتكليف والترتيب والمكلف.
- legal_record_cases تربط سجلًا بأي عدد من القضايا؛ legal_record_links تربط معطى بمستند أو تقرير بمهمة أو فقرة شرح بدليل.
- legal_case_access تُدار بصلاحية المالك فقط.
- لا تغيّر النص الأصلي للمستند تلقائيًا عند تعديل الملخص أو الشرح؛ كل حقل مستقل.
- فقرة الشرح تُكتب كسجل explanation مستقل بترتيب sort_order ويمكن إعادة الترتيب بتعديل القيمة.
- يمكن إضافة عدة تقارير report في نفس اليوم؛ يثبت في كل تقرير user/timestamp، ثم يمكن إنشاء مهمة task جديدة مرتبطة بالتقرير وتعيين مستخدم.
- تنفيذ مهمة «submitted» لا يساوي «verified»؛ الأخير لا يعتمده إلا المالك.

## واجهة المستخدم
- /legal-cases ضمن قائمة الموقع العام، صفحة LegalCasesPage.tsx RTL متجاوبة وتحتوي القضايا، المعطيات، التسلسل الزمني، الشرح، المستندات، المهام، التقارير، الجلسات، الصلاحيات.
- الأرشيف القديم يظهر عبر تفاصيل legacy_snapshot، مع طابور لسجلات لم تُربط بعد.
- GET /api/legal/cases/:id/ai-export يعيد JSON مفصلًا مع روابطه، مناسبًا للقراءة من ChatGPT عبر إضافة الرئيسي بعد إتاحة هذا المسار في موصلها.
- لا يمكن اعتبار رابط PDF دليلًا على قراءة المحتوى؛ استخرج النص واحفظه في content_text بعد المراجعة مع إمكان الرجوع للصورة الأصلية.
- كل تغيير في السجلات يخضع لتدقيق revision وأحداث audit_events.

## Drive (مجلدات تم إنشاؤها بالفعل)
المجلد الأصلي: https://drive.google.com/drive/folders/1vPY4vVouXYMmMd6DB3cOG4lEsVUFys9u
الأرشيف المنظم الجديد: https://drive.google.com/drive/folders/1oVgV6gfIIVUDgcOvcrLCDQKzDZYT-yBn
- ناتكو: https://drive.google.com/drive/folders/1fk6qTz3DpalyPKdhhRucGS4KWNqKFRK5
- ريمان فارما: https://drive.google.com/drive/folders/13STQ7NUUZHz88L9B9zJgb3io3wPBR7Q2
- برايم لايف: https://drive.google.com/drive/folders/1XUQiWzG9a1dwwiXxXvvATRWUBZHzgEnr
- أسام الكبسي: https://drive.google.com/drive/folders/1xfMwUYNw2o3Y-GKOfZ-9T5O80abeKhRh
- عمر العطاس: https://drive.google.com/drive/folders/1ZGqIZPtAjzMN3rSm2L_7qBo6daqq-2G_
- الشهاري: https://drive.google.com/drive/folders/1t5ZNWq9-pF3gaq7AbeOVDd_eFOLAiEd6
- المستندات المشتركة: https://drive.google.com/drive/folders/1OuWBriTzsHzUsMTTnqcf1kDZSjrAIzwl

الأرشيف الجديد لا يعني انتقال المستندات الأصلية: لم يُنقل أو يُحذف ملف من Drive، ولم تُغير صلاحيات مشاركته. رابط المستند يسجل الموضع الأصلي عبر ID الخاص به. يُفحص مضمون الملف قبل نقل/تصنيف أي مستند.

## الملفات التي تأكد وجودها في Drive (فهرس ابتدائي لا إثبات المحتوى)
- ناتكو.pdf: https://drive.google.com/file/d/10mN8X172QJFCbRiDnZgQkAPbSv7_wJE5/view
- ناتكو طلب السير في إجراءات البيع.pdf: https://drive.google.com/file/d/1wSD-ghZEYedhJG5CJ1RfkTSjz3bvL3mb/view
- ناتكو (Google Doc): https://docs.google.com/document/d/1z4m8o6ks8VL1-wdjlbDZUoUwdh6SieU6cRNs_OXoXkU/edit
- شرح قضية ناتكو مع الفهرس نص.txt: https://drive.google.com/file/d/1xmosWbqKs2KKFiPZ4YwqcvWlKTT39JiC/view

## خطوات الاستكمال
- مراجعة الروابط بالسجلات القديمة، دون وصل تلقائي من تشابه الاسم فقط.
- تطوير مربعات ردود المحامين والتوجيهات المرتبطة بالتقارير.
- تحسين ترقيم وترتيب شرح القضية وتحويله إلى ملف Word/PDF عند طلب المستخدم.
- التأكد من إتاحة عمليات الموقع الجديدة في كتالوج إضافة Alraesy للمستخدم صاحب الصلاحية.
- حماية التقارير والمستندات من الوصول العابر للقضايا، وتحديث المراجعة بعد تسجيل المحبوسيات ومهل الطعون.
