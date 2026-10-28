-- Distinct documentation subjects. Idempotent once-only insert; never rewrite owner edits.
INSERT INTO explanation_groups(slug,title,default_read,default_edit)
VALUES ('site-user-guide','دليل استخدام الموقع للمستخدم',NULL,NULL),
       ('site-developer-guide','دليل استخدام الموقع للمطور',NULL,NULL)
ON CONFLICT(slug) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,1,'heading','فكرة الموقع وطريقة العمل','«الرئيسي | Alraesy» نظام ويب عربي لإدارة حساب المستخدم والشركات والمحاسبة والمبيعات والمشتريات والأصناف والمخازن والمذكرات والتواصل والشروح والأرشيف والقضايا. رابط التشغيل: https://alraesy-private-preview.onrender.com. اسم الخدمة الذي يتضمن preview تاريخي وليس دليلًا على بيانات تجريبية. استعمل القائمة الجانبية والاختصارات، وتأكد من الشركة الحالية قبل إدخال مستند. هذا الدليل يشرح الوظائف كلها، لكن فتحه لا يضيف للمستخدم أذونات جديدة.','site-guide-user-001'
FROM explanation_groups WHERE slug='site-user-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,2,'heading','تسجيل حساب وتسجيل الدخول والخروج','افتح /login لإدخال بيانات الدخول، أو /register لإنشاء حساب عام إذا كانت صفحة التسجيل متاحة. الحساب المسجل ليس موظف شركة تلقائيًا. إذا ظهرت خيارات Google أو Apple فاستعملها فقط عندما تكون مهيأة لحسابك. بعد تسجيل الدخول اختر الشركة من /companies. استخدم قائمة صورة المستخدم للخروج عند الانتهاء، وخاصة على جهاز مشترك. قد تتطلب إعادة الدخول بعد تغيير عنوان الموقع أو الجهاز. لا تشارك كلمة مرور أو رمزًا سريًا مع أحد.','site-guide-user-002'
FROM explanation_groups WHERE slug='site-user-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,3,'heading','تعديل الملف الشخصي وكلمة المرور والصورة','من /profile راجع بيانات حسابك، ثم افتح حقل التعديل المتاح واحفظ واستوثق من رسالة نجاح العملية. استخدم خيار تغيير كلمة المرور في حسابك عند توفره؛ اختر كلمة قوية وفريدة. تغيير صورة المستخدم والمظهر يتم من عناصر الحساب المعروضة. يوجد فرق بين «المستخدمون» على مستوى الموقع و«الموظفون» داخل شركة؛ قد يوجد مستخدم بلا سجل موظف. تعديل المستخدمين الآخرين إجراء مستقل عن تعديل الموظف.','site-guide-user-003'
FROM explanation_groups WHERE slug='site-user-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,4,'heading','التنقل والبحث والفرز والمظهر','اختر الصفحة من قائمة التنقل، واستعمل القائمة المختصرة أو زر البحث بدل استعراض جميع البيانات. في الجداول، يمكن تغيير الصفحة وعدد السجلات وفرز النتائج حيث تدعم الصفحة ذلك. اقرأ نتيجة البحث الحالية، خصوصًا عند اختيار صنف أو حساب في فاتورة، ولا تعتمد على نص قديم في القائمة. يمكن للمستخدم اختيار المظهر الفاتح أو الداكن؛ الطباعة تُنسق للورق الأبيض. فتح الرابط المباشر قد يعيد التحقق من الجلسة وإتاحة الصفحة.','site-guide-user-004'
FROM explanation_groups WHERE slug='site-user-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,5,'heading','البدء مع الشركات والفروع والموظفين','من /companies اختر الشركة. تفتح «نظرة عامة» وفيها مدخل السجلات، و«بيانات الشركة» للمعلومات العامة، و«ترويسة الشركة» لبيانات الطباعة. اربط المستخدم بسجل موظف في الشركة إذا كان يعمل فيها، ولا تخلط بين تعريف المستخدم وتعريف الموظف. المواقع التنظيمية: «الفروع»؛ أما المواقع المخزنية فتُسجل في «المعارض والمخازن» و«الرفوف». لا تنقل بيانات شركة إلى أخرى بتعديل رقمها في الرابط.','site-guide-user-005'
FROM explanation_groups WHERE slug='site-user-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,6,'heading','إرسال الرسائل والدردشة والمجموعات','«دردشة الرئيسي» /chat للمحادثات العامة، و«دردشة الشركة» /companies/رقم_الشركة/chat لمحادثات الشركة. اختر المستلم أو مجموعة متاحة، واكتب الرسالة، ثم اضغط إرسال. حالات الاستلام والعرض تختلف عن مجرد إرسال الرسالة. عند إرفاق صورة تحقق من المستلم؛ السماح بإرفاق الصور قد يكون مغلقًا بإعداد عام. في المجموعات تُراعى العضوية وتاريخ الانضمام. لا تستخدم الدردشة لإرسال كلمات المرور أو ملفات سرية إلى غير المخولين.','site-guide-user-006'
FROM explanation_groups WHERE slug='site-user-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,7,'heading','الإشعارات وصندوق التنبيهات','تجد «تنبيهاتك العامة» في /notifications، والتنبيهات الخاصة بالشركة داخل صفحات الشركة. افتح التنبيه لرؤية التفاصيل، ثم استخدم إجراءات المتابعة إذا ظهرت. يمكن أن تُنشأ التنبيهات تلقائيًا من حركة الموقع ولا يلزم أن يكون لكل نوع زر إنشاء. «أنواع التنبيهات» تعرض إعدادات القواعد المتاحة. تطلب إشعارات الهاتف والمتصفح إذن الجهاز، ولا يستطيع الموقع تجاوز حظر المتصفح؛ يبقى صندوق التنبيهات داخل الموقع مرجعًا بديلًا.','site-guide-user-007'
FROM explanation_groups WHERE slug='site-user-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,8,'heading','المذكرات والردود والتحويل والمتابعون','من «المذكرات» في الشركة أنشئ مذكرة بموضوع ومستلم ونص واضح. بعد الإرسال راجع كرت المذكرة والمحادثة والردود والتوجيهات والمتابعين والمرفقات أو الروابط. قد توجد إجراءات مثل طلب الإنجاز واعتماد الإنجاز أو إعادة المهمة للاستكمال؛ لا تعني عبارة «تم الإبلاغ» بالضرورة اعتماد الإغلاق. «تقرير المذكرات» لعرض المتابعة و«قواعد ميزات المذكرات» لتعريف شروط التنبيه أو الإجراء الآلي. راجع صاحب المسؤولية عند تحويل مذكرة.','site-guide-user-008'
FROM explanation_groups WHERE slug='site-user-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,9,'heading','الحضور والانصراف وساعات الدوام','من «الحضور والانصراف» في الشركة سجل الحضور أو الانصراف وفق واجهة الحساب. تابع مواعيد الورديات والتقارير والتصحيحات إذا أُتيح ذلك. يوم العمل قد يمتد إلى بعد منتصف الليل؛ التواريخ التشغيلية تستخدم توقيت عدن. لا تكرر عملية تسجيل الحضور عند بطء الشبكة قبل التأكد من عدم حفظها. يمكن أن تختلف خيارات الحضور باختلاف الموظف وإعدادات الشركة.','site-guide-user-009'
FROM explanation_groups WHERE slug='site-user-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,10,'heading','دليل الحسابات والتعامل مع العملاء والموردين','افتح «دليل الحسابات»، واستخدم البحث للعثور على الحساب وفتح كرت تفاصيله قبل تحرير بياناته أو ربطه بمعاملة. حدد الحساب الفعلي للعميل أو المورد، وتحقق من العملة والصنف والمستند المرتبط. استخدم «أرصدة الحسابات» و«كشف حساب» و«إحصاءات الحسابات» لفهم الحركة خلال المدة المختارة. قد توجد حقول إضافية وحدود وتعريفات في كرت الحساب؛ لا تغيّر الأرصدة مباشرة لمحاولة معالجة خطأ في فاتورة.','site-guide-user-010'
FROM explanation_groups WHERE slug='site-user-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,11,'heading','العملات وأسعار الصرف','من «العملات» اعرف العملة الأساسية والعملات المتاحة. من «أسعار الصرف» تحقق من التاريخ والقيمة السارية قبل تحرير مستند بعملة أخرى. أسعار الصرف التاريخية لا تُستبدل بسعر اليوم عشوائيًا. لا تدخل عددًا تقريبيًا مكان قيمة عشرية معتمدة، ولا تخلط بين الرصيد بعملة الحساب والعملة الأساسية.','site-guide-user-011'
FROM explanation_groups WHERE slug='site-user-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,12,'heading','الأصناف والبحث والكرت والوحدات','من «الأصناف» ابحث بالاسم أو الرمز، ثم افتح الكرت لمراجعة الوحدات والأسعار والصورة والموقع والرف وتاريخ الانتهاء وتراكيب الصنف. تدعم الشركة مستويات وحدات وتحويلات، فحدد وحدة البيع أو الشراء بعناية. «وكلاء الأصناف» و«تراكيب الأصناف» و«متابعة اختلاف شكل الصنف والتركيب» صفحات مستقلة. «تقرير إحصائيات الأصناف» يساعد في فهم تكرار حركة الصنف وكمياتها وفق الفترة المختارة. لا تعتمد على الإحصاء وحده لإثبات جرد.','site-guide-user-012'
FROM explanation_groups WHERE slug='site-user-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,13,'heading','المخزون والمناقلات والتسويات والجرد','«أرصدة المخزون» لمعرفة الكمية في الموقع، و«حركات المخزون» لقراءة أثر المستندات. «المناقلات» لنقل الصنف بين المواقع؛ «تسوية الأصناف» لتسجيل الفارق الناتج عن الجرد، و«متابعة التسويات للأصناف» لمراجعته، و«إعداد المخزون» لضبط الإعدادات المتاحة. عند أي تسوية حدد الصنف والموقع والوحدة والكمية الفعلية، وراجع الفرق قبل الترحيل. السماح المؤقت برصيد سالب لا يلغي مسؤولية المتابعة.','site-guide-user-013'
FROM explanation_groups WHERE slug='site-user-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,14,'heading','إنشاء فاتورة مبيعات','من «فواتير المبيعات» اختر إضافة فاتورة. حدد الحساب، ثم ابحث عن الصنف واختر الوحدة والكمية والسعر؛ راجع الخصم والملاحظات والإجمالي تحت سطور الأصناف. استخدم Enter أو التنقل المتاح بين الحقول، وانتبه للحساب والصنف المعروضين حاليًا. راجع البيانات قبل الحفظ؛ المستند المرحّل قد يؤثر في الأرصدة والمخزون والمحاسبة. عند تأخر الاستجابة تحقق من الفواتير المحفوظة قبل إعادة إرسال الفاتورة حتى لا تتكرر.','site-guide-user-014'
FROM explanation_groups WHERE slug='site-user-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,15,'heading','إنشاء فاتورة مشتريات','من «فواتير المشتريات» أنشئ الفاتورة واختر المورد الفعلي، ورقم وصل المورد عند توفره، والأصناف ووحداتها وكمياتها وأسعارها والعملة والتاريخ. عند وجود تواريخ انتهاء أو دفعات متعددة استخدم الحقول الموجودة في الصفحة بحسب النسخة. لا تخلط بين قيمة الشراء وما دفع للمورد. احفظ راجع الفاتورة المعروضة، ثم تحقق من ظهورها في سجل المشتريات ومن أثرها إن تم ترحيلها.','site-guide-user-015'
FROM explanation_groups WHERE slug='site-user-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,16,'heading','العمليات المالية والقيود والسندات','«العمليات المالية» لعرض المستندات المالية، و«سندات القبض» لإثبات المال المستلم، و«سندات الصرف» لما صُرف، و«قيود اليومية» لقراءة الأثر المحاسبي. قبل الحفظ حدد الحسابات والصندوق أو الحافظة والعملة والقيمة والتاريخ والبيان. ميّز بين المسودة والترحيل؛ لا تستبدل قيدًا ماليًا منشورًا بتعديل غير موثق. اقرأ كشف الحساب بعد الترحيل، وراجع صحة المدين والدائن إذا ظهرت ملاحظة توازن.','site-guide-user-016'
FROM explanation_groups WHERE slug='site-user-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,17,'heading','النقاط والمحافظ والترحيلات والاستلام','«النقاط والمحفظة» تبين حركات النقاط، و«مهام المكافآت» تعرض فرص كسب النقاط المفعّلة، و«إعدادات المحفظة» لضبط قواعد الشركة، و«تحويلات النقاط» لطلب تحويلها عندما تكون السياسة تسمح. «استلام الترحيلات» و«استلام المحفظة الإلكترونية» لعمليات استلام الحركة بين الجهات. تأكد من المبلغ والمستلم والعملية قبل الترحيل، وميّز بين المطابقة التامة والجزئية. النقاط ليست بالضرورة مبلغًا نقديًا حتى تعرّف السياسة قيمة تحويلها.','site-guide-user-017'
FROM explanation_groups WHERE slug='site-user-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,18,'heading','أرشيف المستندات والمرفقات','الأرشيف العام: /archive، وأرشيف الشركة: /companies/رقم_الشركة/archive. حدد «الفئة» و«اسم المرفق» مرة واحدة ثم اختر عدة ملفات، فينشأ لكل صورة أو مستند سجل ورابط مستقل يحملان الفئة والاسم المختارين. يدعم النظام JPG وPNG وWebP وGIF المتحرك وPDF، حتى 8 ميجابايت لكل ملف. في الجدول افتح «عرض / تعديل» وأدخل المحتوى ووجه الاستدلال لكل ملف على حدة. لا تضع مستندات الشركة الحساسة في الأرشيف العام. يمكن تخصيص فئات من الأرشيف العام لتظهر في سياق القضايا.','site-guide-user-018'
FROM explanation_groups WHERE slug='site-user-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,19,'heading','قراءة الشروح والموضوعات المستقلة','«قراءة الشروح» تعرض قائمة اختيار الموضوع. توجد ثلاثة مواضيع رئيسية حاليًا: «شرح قضايا مصطفى» و«دليل استخدام الموقع للمستخدم» و«دليل استخدام الموقع للمطور». بعد اختيار الموضوع تُعرض فصوله دون جلب نصه كله؛ افتح فصلًا لقراءة تفاصيله وطباعته منفردًا. تحرير الشروح من صفحة منفصلة؛ مجرد قراءة دليل لا يمنح صلاحية تعديل بيانات التطبيق. يمكن إضافة مواضيع مستقلة أخرى في المستقبل.','site-guide-user-019'
FROM explanation_groups WHERE slug='site-user-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,20,'heading','إدارة القضايا والأولويات والمعطيات','«إدارة قضايا مصطفى» تضم القضايا والمهام والأحداث والتسلسل الزمني والمعطيات والمستندات والتقارير. افتح القضية أو السجل للتحقق من ارتباطه بالمستند الأصلي وتاريخه. الأولويات المرتبطة بمواعيد أو إجراءات هي أدوات متابعة وليست أحكامًا نهائية. قد تُعرض فئات مختارة من الأرشيف العام داخل القضايا، بينما يظل أصل المستند محفوظًا في أرشيفه. صلاحيات القضايا مستقلة عن إتاحة الدليل.','site-guide-user-020'
FROM explanation_groups WHERE slug='site-user-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,21,'heading','قائمة الصفحات والكنترول والخيارات والصلاحيات','«قائمة الصفحات» تعرض الصفحات المسجلة وتصنيفاتها. «الكنترول» في الشركة يعرض الخيارات التشغيلية التي يمكن تفعيلها أو إخفاؤها. «الخيارات والصلاحيات» و«مركز الصلاحيات وخيارات النظام» يعرضان عناصر إعداد الشركة عند إتاحتها. قد لا يكون ظهور الصفحة دليلًا على صلاحية تنفيذ كل إجراء؛ الحفظ والفاتورة والموافقة إجراءات مستقلة. استخدم سجل التدقيق لقراءة من عدل بيانات ومتى إذا كان معروضًا لحسابك.','site-guide-user-021'
FROM explanation_groups WHERE slug='site-user-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,22,'heading','السجل العام وسجل الشركة ومراجعة الأخطاء','سجل الموقع العام /audit منفصل عن «سجل الشركة» ضمن صفحات الشركة. عند خطأ في الحفظ اقرأ رسالة الخطأ أولًا، ولا تعاود تنفيذ سند أو فاتورة قبل فحص النتيجة. إذا تعطل فتح صفحة تحقق من الجلسة والشركة والرابط أولًا. عند وجود اختلاف مادي في رصيد أو مستند حافظ على رقم العملية وتاريخها وعنوانها، ثم راجع كرتها وسجل التدقيق. لا تُدخل بيانات بديلة للتغلب على خطأ الصلاحية.','site-guide-user-022'
FROM explanation_groups WHERE slug='site-user-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,23,'heading','إرشادات الطباعة وحفظ الأدلة','عند قراءة فصل من الشروح اضغط «طباعة الموضوع» لتطبع ذلك الفصل فقط. لا تُطبع جميع فصول دليل آخر أو جميع القضايا معًا. عند فتح صورة أو PDF يمكن التنزيل بحسب أدوات المتصفح. احتفظ بأسماء الملفات وتواريخها والنسخة الأصلية عند التعامل مع المستندات، ولا تستنتج محتوى صورة لم تراجعها. تنسيق الطباعة قد يكون أبيض حتى لو اختار المستخدم المظهر الداكن.','site-guide-user-023'
FROM explanation_groups WHERE slug='site-user-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,24,'heading','ماذا تفعل عند بطء الموقع أو انقطاع الإنترنت','عند بطء البحث، قلّص المصطلح أو حدد الفئة إن أمكن وتحقق من نتيجة الطلب. لا تفترض أن شاشة تحميل قديمة تعني اكتمال الحفظ. إذا انقطع الإنترنت أثناء فاتورة أو سند، لا تكرر الضغط إلا بعد التأكد من عدم ظهور العملية في القائمة. دعم الإدخال دون إنترنت والمزامنة يجب التحقق من إتاحته فعليًا في النسخة الحالية قبل الاعتماد عليه؛ مجرد وجود طلب سابق لا يعني عمله في كل صفحة. استخدم آخر نتيجة مؤكدة من الخادم.','site-guide-user-024'
FROM explanation_groups WHERE slug='site-user-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,25,'heading','مرجع الصفحات: الموقع العام','هذا فهرس للصفحات التي سجلها الكود الحالي في قسم «الموقع العام». الروابط التي تحتوي :companyId أو :recordId تشير إلى معرف الشركة أو السجل الحقيقي، ولا يجوز تخمين المعرف.

1. الرئيسية — /. صفحة الرئيسية ضمن الموقع العام. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

2. قائمة الصفحات — /pages. صفحة قائمة الصفحات ضمن الموقع العام. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

3. الشركات — /companies. صفحة الشركات ضمن الموقع العام. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

4. تنبيهاتك العامة — /notifications. صفحة تنبيهاتك العامة ضمن الموقع العام. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

5. أنواع التنبيهات العامة — /notification-templates. صفحة أنواع التنبيهات العامة ضمن الموقع العام. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

6. دردشة الرئيسي — /chat. صفحة دردشة الرئيسي ضمن الموقع العام. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.','site-guide-user-025'
FROM explanation_groups WHERE slug='site-user-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,26,'heading','مرجع الصفحات: الحساب والهوية','هذا فهرس للصفحات التي سجلها الكود الحالي في قسم «الحساب والهوية». الروابط التي تحتوي :companyId أو :recordId تشير إلى معرف الشركة أو السجل الحقيقي، ولا يجوز تخمين المعرف.

1. حسابي — /profile. صفحة حسابي ضمن الحساب والهوية. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

2. تسجيل الدخول — /login. صفحة تسجيل الدخول ضمن الحساب والهوية. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

3. إنشاء حساب — /register. صفحة إنشاء حساب ضمن الحساب والهوية. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.','site-guide-user-026'
FROM explanation_groups WHERE slug='site-user-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,27,'heading','مرجع الصفحات: إدارة المنصة','هذا فهرس للصفحات التي سجلها الكود الحالي في قسم «إدارة المنصة». الروابط التي تحتوي :companyId أو :recordId تشير إلى معرف الشركة أو السجل الحقيقي، ولا يجوز تخمين المعرف.

1. المستخدمون — /users. صفحة المستخدمون ضمن إدارة المنصة. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

2. الجدول العام — /general-table. صفحة الجدول العام ضمن إدارة المنصة. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.','site-guide-user-027'
FROM explanation_groups WHERE slug='site-user-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,28,'heading','مرجع الصفحات: الأرشيف','هذا فهرس للصفحات التي سجلها الكود الحالي في قسم «الأرشيف». الروابط التي تحتوي :companyId أو :recordId تشير إلى معرف الشركة أو السجل الحقيقي، ولا يجوز تخمين المعرف.

1. أرشيف المستندات والمرفقات — /archive. صفحة أرشيف المستندات والمرفقات ضمن الأرشيف. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.','site-guide-user-028'
FROM explanation_groups WHERE slug='site-user-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,29,'heading','مرجع الصفحات: إدارة القضايا','هذا فهرس للصفحات التي سجلها الكود الحالي في قسم «إدارة القضايا». الروابط التي تحتوي :companyId أو :recordId تشير إلى معرف الشركة أو السجل الحقيقي، ولا يجوز تخمين المعرف.

1. إدارة قضايا مصطفى — /legal-cases. صفحة إدارة قضايا مصطفى ضمن إدارة القضايا. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.','site-guide-user-029'
FROM explanation_groups WHERE slug='site-user-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,30,'heading','مرجع الصفحات: الشروح المنظمة','هذا فهرس للصفحات التي سجلها الكود الحالي في قسم «الشروح المنظمة». الروابط التي تحتوي :companyId أو :recordId تشير إلى معرف الشركة أو السجل الحقيقي، ولا يجوز تخمين المعرف.

1. قراءة الشروح — /explanations/topics. صفحة قراءة الشروح ضمن الشروح المنظمة. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

2. إضافة وتعديل الشروح — /explanations?group=mustafa-cases. صفحة إضافة وتعديل الشروح ضمن الشروح المنظمة. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.','site-guide-user-030'
FROM explanation_groups WHERE slug='site-user-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,31,'heading','مرجع الصفحات: الإدارة والصلاحيات','هذا فهرس للصفحات التي سجلها الكود الحالي في قسم «الإدارة والصلاحيات». الروابط التي تحتوي :companyId أو :recordId تشير إلى معرف الشركة أو السجل الحقيقي، ولا يجوز تخمين المعرف.

1. منح صلاحيات صفحات الشروح — /explanations/access. صفحة منح صلاحيات صفحات الشروح ضمن الإدارة والصلاحيات. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

2. مركز الصلاحيات وخيارات النظام — /companies/:companyId/central-access. صفحة مركز الصلاحيات وخيارات النظام ضمن الإدارة والصلاحيات. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.','site-guide-user-031'
FROM explanation_groups WHERE slug='site-user-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,32,'heading','مرجع الصفحات: التدقيق','هذا فهرس للصفحات التي سجلها الكود الحالي في قسم «التدقيق». الروابط التي تحتوي :companyId أو :recordId تشير إلى معرف الشركة أو السجل الحقيقي، ولا يجوز تخمين المعرف.

1. السجل العام — /audit. صفحة السجل العام ضمن التدقيق. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

2. سجل الشركة — /companies/:companyId/audit. صفحة سجل الشركة ضمن التدقيق. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.','site-guide-user-032'
FROM explanation_groups WHERE slug='site-user-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,33,'heading','مرجع الصفحات: الشركة','هذا فهرس للصفحات التي سجلها الكود الحالي في قسم «الشركة». الروابط التي تحتوي :companyId أو :recordId تشير إلى معرف الشركة أو السجل الحقيقي، ولا يجوز تخمين المعرف.

1. نظرة عامة — /companies/:companyId. صفحة نظرة عامة ضمن الشركة. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

2. قائمة الصفحات — /companies/:companyId/pages. صفحة قائمة الصفحات ضمن الشركة. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

3. أرشيف مستندات الشركة — /companies/:companyId/archive. صفحة أرشيف مستندات الشركة ضمن الشركة. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

4. الكنترول — /companies/:companyId/control. صفحة الكنترول ضمن الشركة. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

5. الخيارات والصلاحيات — /companies/:companyId/configuration. صفحة الخيارات والصلاحيات ضمن الشركة. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

6. الموظفون — /companies/:companyId/employees. صفحة الموظفون ضمن الشركة. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

7. بيانات الشركة — /companies/:companyId/settings. صفحة بيانات الشركة ضمن الشركة. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

8. ترويسة الشركة — /companies/:companyId/letterhead. صفحة ترويسة الشركة ضمن الشركة. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

9. التنبيهات — /companies/:companyId/notifications. صفحة التنبيهات ضمن الشركة. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

10. أنواع التنبيهات — /companies/:companyId/notification-templates. صفحة أنواع التنبيهات ضمن الشركة. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

11. المذكرات — /companies/:companyId/memos. صفحة المذكرات ضمن الشركة. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

12. تقرير المذكرات — /companies/:companyId/memo-report. صفحة تقرير المذكرات ضمن الشركة. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

13. قواعد ميزات المذكرات — /companies/:companyId/memo-feature-rules. صفحة قواعد ميزات المذكرات ضمن الشركة. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

14. عرض المذكرة — /companies/:companyId/memos/:recordId. صفحة عرض المذكرة ضمن الشركة. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

15. الفروع — /companies/:companyId/branches. صفحة الفروع ضمن الشركة. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

16. المعارض والمخازن — /companies/:companyId/locations. صفحة المعارض والمخازن ضمن الشركة. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.','site-guide-user-033'
FROM explanation_groups WHERE slug='site-user-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,34,'heading','مرجع الصفحات: الموظفون','هذا فهرس للصفحات التي سجلها الكود الحالي في قسم «الموظفون». الروابط التي تحتوي :companyId أو :recordId تشير إلى معرف الشركة أو السجل الحقيقي، ولا يجوز تخمين المعرف.

1. النقاط والمحفظة — /companies/:companyId/wallet. صفحة النقاط والمحفظة ضمن الموظفون. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

2. مهام المكافآت — /companies/:companyId/reward-tasks. صفحة مهام المكافآت ضمن الموظفون. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

3. إعدادات المحفظة — /companies/:companyId/wallet-settings. صفحة إعدادات المحفظة ضمن الموظفون. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

4. تحويلات النقاط — /companies/:companyId/wallet-conversions. صفحة تحويلات النقاط ضمن الموظفون. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

5. الحضور والانصراف — /companies/:companyId/attendance. صفحة الحضور والانصراف ضمن الموظفون. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.','site-guide-user-034'
FROM explanation_groups WHERE slug='site-user-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,35,'heading','مرجع الصفحات: المحاسبة','هذا فهرس للصفحات التي سجلها الكود الحالي في قسم «المحاسبة». الروابط التي تحتوي :companyId أو :recordId تشير إلى معرف الشركة أو السجل الحقيقي، ولا يجوز تخمين المعرف.

1. دليل الحسابات — /companies/:companyId/accounts. صفحة دليل الحسابات ضمن المحاسبة. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

2. العملات — /companies/:companyId/currencies. صفحة العملات ضمن المحاسبة. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

3. أسعار الصرف — /companies/:companyId/exchange-rates. صفحة أسعار الصرف ضمن المحاسبة. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

4. العمليات المالية — /companies/:companyId/financial-documents. صفحة العمليات المالية ضمن المحاسبة. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

5. قيود اليومية — /companies/:companyId/journals. صفحة قيود اليومية ضمن المحاسبة. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

6. سندات القبض — /companies/:companyId/receipts. صفحة سندات القبض ضمن المحاسبة. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

7. سندات الصرف — /companies/:companyId/payments. صفحة سندات الصرف ضمن المحاسبة. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

8. إضافة مستند مالي — /companies/:companyId/financial-documents/new. صفحة إضافة مستند مالي ضمن المحاسبة. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

9. عرض المستند المالي — /companies/:companyId/financial-documents/:recordId. صفحة عرض المستند المالي ضمن المحاسبة. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.','site-guide-user-035'
FROM explanation_groups WHERE slug='site-user-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,36,'heading','مرجع الصفحات: المبيعات','هذا فهرس للصفحات التي سجلها الكود الحالي في قسم «المبيعات». الروابط التي تحتوي :companyId أو :recordId تشير إلى معرف الشركة أو السجل الحقيقي، ولا يجوز تخمين المعرف.

1. الأطباء والجهات — /companies/:companyId/doctors. صفحة الأطباء والجهات ضمن المبيعات. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.','site-guide-user-036'
FROM explanation_groups WHERE slug='site-user-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,37,'heading','مرجع الصفحات: الأصناف والمخزون','هذا فهرس للصفحات التي سجلها الكود الحالي في قسم «الأصناف والمخزون». الروابط التي تحتوي :companyId أو :recordId تشير إلى معرف الشركة أو السجل الحقيقي، ولا يجوز تخمين المعرف.

1. الأصناف — /companies/:companyId/items. صفحة الأصناف ضمن الأصناف والمخزون. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

2. تقرير إحصائيات الأصناف — /companies/:companyId/item-statistics-report. صفحة تقرير إحصائيات الأصناف ضمن الأصناف والمخزون. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

3. كرت الصنف — /companies/:companyId/items/:recordId. صفحة كرت الصنف ضمن الأصناف والمخزون. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

4. إضافة صنف — /companies/:companyId/items/new. صفحة إضافة صنف ضمن الأصناف والمخزون. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

5. تراكيب الأصناف — /companies/:companyId/item-compositions. صفحة تراكيب الأصناف ضمن الأصناف والمخزون. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

6. متابعة اختلاف شكل الصنف والتركيب — /companies/:companyId/item-form-differences. صفحة متابعة اختلاف شكل الصنف والتركيب ضمن الأصناف والمخزون. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

7. كرت الرفوف — /companies/:companyId/item-shelves. صفحة كرت الرفوف ضمن الأصناف والمخزون. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

8. وكلاء الأصناف — /companies/:companyId/item-agents. صفحة وكلاء الأصناف ضمن الأصناف والمخزون. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

9. متابعة التسويات للأصناف — /companies/:companyId/settlement-follow-up. صفحة متابعة التسويات للأصناف ضمن الأصناف والمخزون. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

10. المناقلات — /companies/:companyId/stock-operations. صفحة المناقلات ضمن الأصناف والمخزون. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

11. تسوية الأصناف — /companies/:companyId/stock-adjustments. صفحة تسوية الأصناف ضمن الأصناف والمخزون. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

12. إعداد المخزون — /companies/:companyId/inventory-settings. صفحة إعداد المخزون ضمن الأصناف والمخزون. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.','site-guide-user-037'
FROM explanation_groups WHERE slug='site-user-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,38,'heading','مرجع الصفحات: التقارير','هذا فهرس للصفحات التي سجلها الكود الحالي في قسم «التقارير». الروابط التي تحتوي :companyId أو :recordId تشير إلى معرف الشركة أو السجل الحقيقي، ولا يجوز تخمين المعرف.

1. أرصدة المخزون — /companies/:companyId/stock-balances. صفحة أرصدة المخزون ضمن التقارير. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

2. حركات المخزون — /companies/:companyId/stock-movements. صفحة حركات المخزون ضمن التقارير. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

3. أرصدة الحسابات — /companies/:companyId/account-balances. صفحة أرصدة الحسابات ضمن التقارير. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

4. كشف حساب — /companies/:companyId/account-ledger. صفحة كشف حساب ضمن التقارير. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

5. كشف حساب صندوقي — /companies/:companyId/my-cashbox-ledger. صفحة كشف حساب صندوقي ضمن التقارير. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

6. إحصاءات الحسابات — /companies/:companyId/account-statistics. صفحة إحصاءات الحسابات ضمن التقارير. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.','site-guide-user-038'
FROM explanation_groups WHERE slug='site-user-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,39,'heading','مرجع الصفحات: الفواتير','هذا فهرس للصفحات التي سجلها الكود الحالي في قسم «الفواتير». الروابط التي تحتوي :companyId أو :recordId تشير إلى معرف الشركة أو السجل الحقيقي، ولا يجوز تخمين المعرف.

1. فواتير المبيعات — /companies/:companyId/sales. صفحة فواتير المبيعات ضمن الفواتير. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

2. استلام الترحيلات — /companies/:companyId/pouch-receipts. صفحة استلام الترحيلات ضمن الفواتير. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

3. استلام المحفظة الإلكترونية — /companies/:companyId/electronic-receipts. صفحة استلام المحفظة الإلكترونية ضمن الفواتير. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

4. فواتير المشتريات — /companies/:companyId/purchases. صفحة فواتير المشتريات ضمن الفواتير. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

5. إضافة فاتورة مبيعات — /companies/:companyId/invoices/new?kind=sale. صفحة إضافة فاتورة مبيعات ضمن الفواتير. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

6. إضافة فاتورة مشتريات — /companies/:companyId/invoices/new?kind=purchase. صفحة إضافة فاتورة مشتريات ضمن الفواتير. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.

7. عرض الفاتورة — /companies/:companyId/invoices/:recordId. صفحة عرض الفاتورة ضمن الفواتير. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.','site-guide-user-039'
FROM explanation_groups WHERE slug='site-user-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,40,'heading','مرجع الصفحات: التواصل','هذا فهرس للصفحات التي سجلها الكود الحالي في قسم «التواصل». الروابط التي تحتوي :companyId أو :recordId تشير إلى معرف الشركة أو السجل الحقيقي، ولا يجوز تخمين المعرف.

1. دردشة الشركة — /companies/:companyId/chat. صفحة دردشة الشركة ضمن التواصل. استخدمها لإدارة أو قراءة البيانات المرتبطة باسمها، وراجع الحقول والنتائج المتاحة في نسختك قبل الحفظ.','site-guide-user-040'
FROM explanation_groups WHERE slug='site-user-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,1,'heading','ما هو مرجع الحقيقة للمطور','المستودع المعتمد daraldawaye-ship-it/mus على GitHub. اقرأ AGENTS.md وdocs/PROJECT_CONTEXT.md قبل أي تغيير. فرع خدمة Render الفعلي هو preview/render-2026-10-23، بالرغم من اسمه التاريخي؛ فرع main لا يُعد نسخة الإنتاج دون التحقق. مصدر الحقيقة لحالة الميزة هو كود هذا الفرع وترحيلات قاعدة البيانات والعقود والاختبارات، ثم تحقق الإصدار الذي نشر فعليًا على Render. لا تستنتج وجود ميزة من نقاش قديم أو من وثيقة تاريخية فقط.','site-guide-dev-001'
FROM explanation_groups WHERE slug='site-developer-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,2,'heading','مخطط التطبيق وإطارات العمل','الواجهة React 19 مع TypeScript وVite وreact-router-dom وTanStack Query؛ خادم HTTP يستخدم Express 5 وTypeScript وtsx، وقاعدة البيانات PostgreSQL عبر مكتبة pg. التطبيقات ضمن apps/web وapps/api، والعقود المشتركة في packages/contracts. حاوية واحدة تقدّم الواجهة الثابتة وواجهات /api وتعمل مع PostgreSQL مستقلة. بنيّة متاحة: apps/web/src/App.tsx وصفحات apps/web/src/pages، وapps/api/src/app.ts وbusiness-routes.ts ومسارات routes-*.ts.','site-guide-dev-002'
FROM explanation_groups WHERE slug='site-developer-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,3,'heading','روابط الخدمة ومساحة العمل','الموقع العامل: https://alraesy-private-preview.onrender.com، الفحص الصحي: /api/health. مساحة عمل Render: dar''s workspace، ومعرفها tea-dbdlf50ae00c738jupv0. الخدمة alraesy-private-preview بمعرف srv-dbdlueo473hc73cqtsb0. PostgreSQL: alraesy-preview-db بمعرف dpg-dbdltoo473hc73cqrkqg-a، وقاعدة التطبيق tijara_preview. المنطقة Frankfurt. وجود «preview» اسم تاريخي ولا يجوز إنشاء خدمة أو قاعدة بديلة بسبب الاسم. لا تُعرض كلمات المرور أو روابط الاتصال الخاصة في الدليل.','site-guide-dev-003'
FROM explanation_groups WHERE slug='site-developer-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,4,'heading','الاتصال بـ GitHub وتحديث الكود','راجع الفرع النشط وعنوان commit قبل التعديل. استخدم تكامل GitHub لقراءة الملفات والبحث والتحديث، واحفظ رسائل commits واضحة. لا تدفع إلى main اعتمادًا على أنه الإنتاج؛ استخدم فرع Render الفعلي، وراجع تاريخ التغييرات الحديثة قبل حل تعارض. لا تعدل الملف كاملًا دون فحص العلاقات التي تستعمله. اقرأ PRs المفتوحة عند احتمال وجود عمل غير مدمج، ولا تطغَ على تعديلات متزامنة.','site-guide-dev-004'
FROM explanation_groups WHERE slug='site-developer-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,5,'heading','الاتصال بـ Render والتحقق من النشر','استخدم تكامل Render لاختيار مساحة العمل المؤكدة، ثم list_services وget_service وlist_deploys وlist_logs. خدمة الإنتاج التاريخية الاسم ترتبط بفرع preview/render-2026-10-23 والنشر التلقائي مغلق؛ بعد رفع تعديلات الفرع شغّل trigger_deploy يدويًا إن كان النشر مصرحًا، ثم تابع get_deploy حتى status=live. تحقق من health والواجهة ومسار العمل المتغير، ولا تعد نجاح git commit نشرًا. راجع أي تكاليف جديدة قبل تغيير خطط قاعدة البيانات أو الخدمة.','site-guide-dev-005'
FROM explanation_groups WHERE slug='site-developer-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,6,'heading','قاعدة PostgreSQL وترحيلات البنية','البيانات في PostgreSQL مستقلة عن حاوية الويب. عند إنشاء التطبيق تستخدم createDatabase في apps/api/src/db.ts ملف DATABASE_URL من أسرار البيئة وDATABASE_SCHEMA الافتراضي public. ترحيلات SQL مرتبة رقميًا في apps/api/migrations وتُسجل في schema_migrations داخل عملية مقفلة بمعرف النطاق. أضف ملف ترحيل جديدًا بدل تعديل ملف سبق تطبيقه. ضع فهارس للقراءات الشائعة وقيود FK وCHECK الملائمة، ولا تحذف أو تعيد بناء بيانات المستخدم للتغلب على خطأ في schema.','site-guide-dev-006'
FROM explanation_groups WHERE slug='site-developer-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,7,'heading','الاتصال الآمن بقاعدة البيانات','استعمل قيمة DATABASE_URL المعتمدة من أسرار Render المرتبطة بقاعدة PostgreSQL الداخلية في المنطقة نفسها؛ لا تضع الرابط في Git أو الوثائق العامة. الاتصال المباشر بقاعدة الإنتاج لإجراء تغييرات بيانات ليس بديلًا عن واجهات التطبيق المصرح بها. عند قراءة أو تعديل البيانات عبر اتصال الرئيسي المعتمد استخدم سجل عمليات API، واقرأ العقد ومعرف السجل ومراجعة التزامن. لا توسع وصول القاعدة عبر الشبكة العامة لتسهيل التطوير.','site-guide-dev-007'
FROM explanation_groups WHERE slug='site-developer-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,8,'heading','فحص البيئة والبناء والاختبارات','جذر المستودع يحتوي package.json وpackage-lock.json وtsconfig.json وDockerfile. استخدم Node 24 كما في Dockerfile. فحص الأنواع: npm run check؛ بناء الواجهة: npm run build؛ الاختبارات: npm test. توجد اختبارات متصفح متخصصة في tests/ مع أوامر package.json. Dockerfile يستخدم npm ci ثم check ثم build؛ فشل البناء يمنع نشر تحديث سليم. راجع سجلات البناء أو اختبارات المسار المعدل لا تُعلن نجاح اختبار لم يُشغّل.','site-guide-dev-008'
FROM explanation_groups WHERE slug='site-developer-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,9,'heading','الجلسات والمصادقة وحماية التعديل','يبدأ الربط في apps/api/src/app.ts. loadSession يفحص جلسة المستخدم، وmutationSecurity يتحقق من Origin ورمز CSRF للعمليات المعدلة. واجهات OAuth وMCP لها فحوص منفصلة ولا يجوز تمريرها حول حماية المتصفح. تستخدم الواجهة دالة api في apps/web/src/api.tsx وتضيف اعتماد الجلسة وCSRF تلقائيًا. في واجهات الاتصال الجديدة لا تطبع محتوى الرموز أو كلمات السر في السجلات. لا تمنح إنشاء حساب عام حق الوصول إلى كل شركة.','site-guide-dev-009'
FROM explanation_groups WHERE slug='site-developer-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,10,'heading','عزل الشركة والأدوار والصلاحيات','الهوية العامة للمستخدم ليست عضوية شركة. يدقق companyAccess في apps/api/src/policies/access.ts في سجل الشركة والموظف وصلاحياته، والمالك فقط له سلطات محددة. صفحة الدليل ليست مصدرًا كافيًا للإذن؛ يجب تطبيق التحقق في route نفسه. تعريفات الصفحات في packages/contracts/src/pages.ts، ويعكس services/pages.ts وroutes-pages.ts قواعد الإتاحة والمنح. يجب التمييز بين view وcreate وedit وpost وreverse وprint. ابدأ بأقل إذن وامنع القراءة المتقاطعة بين الشركات.','site-guide-dev-010'
FROM explanation_groups WHERE slug='site-developer-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,11,'heading','واجهات API وعقود الاتصال','أغلب المسارات تبدأ /api. راجع apps/api/src/business-routes.ts لمعرفة مسارات الأقسام، وroutes-*.ts للتحقق من مخططات Zod والمعاملات والتدقيق. اتصال الرئيسي داخل ChatGPT يوفر tijara_api_catalog وtijara_api_read وtijara_api_write للعمليات التي نُشرت صراحة؛ وجود صفحة لا يعني أن كل إجراء مسجل في اتصال MCP. اقرأ عقد METHOD /path والحقول المطلوبة والتزامن ومعرف idempotency قبل الكتابة. إذا لم يوجد العقد فلا تخمّنه ولا تستخدم جدولًا عامًا بديلًا.','site-guide-dev-011'
FROM explanation_groups WHERE slug='site-developer-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,12,'heading','الدليل والمجموعات والشروح','الجداول explanation_groups وexplanation_nodes وexplanation_assets وexplanation_links، ومسارات apps/api/src/routes-explanations.ts. واجهة القراءة apps/web/src/pages/ExplanationsReader.tsx. كل مجموعة دليل مستقل، وكل فصل عنوان من المستوى الأعلى. طلب /explanations/groups لا يعيد محتوى كل الفصول، وGET /explanations/groups/:groupId/topics يعيد العناوين فقط، وGET /explanations/topics/:topicId يعيد فصلًا واحدًا مع فروعه. لا تستخدم document?all=true للقراءة العادية؛ كانت تستخدم للطباعة المتصلة. دليلا المستخدم والمطور مفتوحان للقراءة للحسابات النشطة دون منح إضافي، بينما تحريرهما للمالك ما لم يغير حقوقهما.','site-guide-dev-012'
FROM explanation_groups WHERE slug='site-developer-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,13,'heading','قاعدة بيانات الأرشيف والمرفقات','الترحيل 142_document_archive.sql ينشئ archive_categories وarchive_files مع company_id اختياري لفصل العام عن شركة محددة. يدعم الخادم رفع base64 لصيغ JPEG وPNG وWebP وGIF الأصلي وPDF، ويمنع الحجم فوق 8 MiB للملف. كرت المرفق يحفظ content_text وevidence_text لكل ملف منفردًا مع revision لمنع تجاوز تحديث أحدث. المسارات في routes-archive.ts والواجهة ArchivePage.tsx، مع فحص صفحة الأرشيف المناسب وإذن الشركة في كل قراءة أو تحديث. لا تعرض محتوى الملف لغير المخول؛ لا تحوّل GIF المتحرك إلى صورة ثابتة.','site-guide-dev-013'
FROM explanation_groups WHERE slug='site-developer-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,14,'heading','الدردشة والصور والخصوصية','راجع apps/api/src/routes-chat.ts وroutes-chat-groups.ts وroutes-media.ts والواجهة ChatPage. الرسائل الخاصة والمجموعات تحدد المستلمين والأعضاء؛ قراءة صورة من media_assets ليست مسموحة لمجرد معرفة معرّفها. توجد إعدادات تمكين صور المجموعات والرسائل المباشرة، مع استثناء موثق لمالك الموقع. يجب منع عرض صور أو رسائل خارج المحادثة، وتسجيل عمليات التعديل والتأكد من فحص عضوية المجموعة. راجع docs/CHAT.md.','site-guide-dev-014'
FROM explanation_groups WHERE slug='site-developer-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,15,'heading','الأصناف والحسابات والوحدات والتحويل','المستندات المساعدة docs/PHASE_4_ITEMS.md وdocs/ACCOUNT_STATISTICS_INTEGRATION.md وdocs/ITEM_STATISTICS.md. حساب الصنف يتعامل مع مستويات وحدات وتحويلات، وسعر الشراء والبيع قد يختلف بالوحدة والعملة. لا تستخدم Number أو parseFloat عند نقل أرقام مالية دقيقة إلى قاعدة البيانات؛ العقود تقبل decimal strings وتحفظ PostgreSQL NUMERIC. لا تعتبر عرض رصيد الصنف تحويلًا مخزنيًا، ولا تضف حركة تعكس حجزًا غير موجود. حافظ على العلاقات والفهارس الخاصة ببحث الأصناف.','site-guide-dev-015'
FROM explanation_groups WHERE slug='site-developer-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,16,'heading','الفواتير والمخزون والقيود المالية','راجع docs/PHASE_5_COMMERCE.md وdocs/PHASE_3_ACCOUNTING.md وdocs/HISTORICAL_TRANSACTION_IMPORT.md. أدخل فاتورة أو سندًا عبر واجهة التطبيق المصرح بها فقط، مع مراعاة idempotency والمراجعات. المسودة والحفظ والترحيل المحاسبي والمخزني خطوات مختلفة. الترحيل الفعلي يؤثر في القيد والرصيد والحركة، لذلك لا تُعد تشغيله دون معرفة حالة المعاملة. المستخدم سبق أن طلب إيقاف ترحيل الفواتير؛ لا تستأنف تلقائيًا بسبب تعديل دليل أو نشر واجهة. أي تشغيل معالجات العمال يتطلب مراجعة الحالة الحالية وتوجيه المستخدم.','site-guide-dev-016'
FROM explanation_groups WHERE slug='site-developer-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,17,'heading','المذكرات والمحفظة والموظفون','راجع docs/MEMOS.md وdocs/WALLET.md وdocs/ATTENDANCE.md وdocs/NOTIFICATIONS.md. مهام المذكرات والاعتمادات ترتبط بالمستخدمين والموظفين والأدوار داخل الشركة، والردود والمتابعون معلومات مستقلة. المحفظة تحتفظ بنقاط وسجل حركات وسياسات تحويل؛ لا تساوِ النقاط بالعملة دون سياسة صريحة. أوقات دوام الموظفين تعمل بتوقيت عدن وتراعي الورديات العابرة لمنتصف الليل. لا تعدّل قاعدة منفصلة لتنشيط إجراء غير مكتمل في الواجهة.','site-guide-dev-017'
FROM explanation_groups WHERE slug='site-developer-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,18,'heading','النشر الخاص واسم الموقع والمحركات التلقائية','الاسم المعتمد «الرئيسي | Alraesy»، ولا تستخدم اسم تجارة كاسم واجهة جديدة وإن بقي في أسماء تقنية للتوافق. النظام يخدم من Render؛ Railway مصدر تاريخي مجمّد ولا تُنشر عليه تحديثات. تحقق من flags والـ workers قبل أي تغيير يتعلق بالترحيل أو الحسابات. لا تفسر إعادة تشغيل حاوية Render كإذن لإعادة معالجة فواتير أو بيانات. حافظ على إعدادات OAuth وVAPID وجلسات المستخدم كما هي إلا إذا طلبت مهمة تغييرها صراحة.','site-guide-dev-018'
FROM explanation_groups WHERE slug='site-developer-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,19,'heading','الأحداث والسجل العام والأمن','استخدم audit من apps/api/src/services/audit.ts وتعاريف AuditAction في packages/contracts/src/index.ts لأحداث الحفظ الحساسة. سجل التدقيق لا يتضمن كلمات مرور أو بيانات الملفات الثنائية أو النصوص الخاصة غير اللازمة. تجنب حقن SQL عبر ترتيب المستخدم؛ استخدم query parameters ومخططات Zod، واحترم معرفات الصفحات المسجلة. احمِ PDF والصور من الوصول غير المصرح، وحدّد Cache-Control وContent-Disposition وسياسة منع تنفيذ محتوى HTML مع أي ملف من المستخدم.','site-guide-dev-019'
FROM explanation_groups WHERE slug='site-developer-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,20,'heading','آلية الاستجابة المستقبلية لمهام التطوير','لأي طلب تطوير جديد: افحص المصدر الحالي والفرع الفعلي، حدد الصفحة والـ API والجدول المرتبط، ثم عدل بأقل تغييرات متسقة مع البيانات السابقة. اختبر TypeScript والواجهة والعمليات الحساسة، وادفع إلى فرع Render المعتمد، وانشر يدويًا عند التفويض، وانتظر حالة live وتحقق من health والسلوك. لا تزعم نجاح وظيفة لم تُجرب. إذا طال العمل اذكر حالة التنفيذ الحقيقية بوضوح. حدّث هذا الدليل عند تغيير بنية الأقسام والعقود، ولا تجعل الشروح مستودعًا لأسرار أو روابط اتصال خاصة.','site-guide-dev-020'
FROM explanation_groups WHERE slug='site-developer-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,21,'heading','تشخيص الأخطاء والبناء الفاشل','إذا فشل Render build افحص npm run check ثم أخطاء TypeScript ثم npm run build. إذا انتهى النشر مع تعطل endpoint افحص logs و /api/health وحالة اتصال PostgreSQL وترحيلات schema_migrations. نجاح health وحده لا يؤكد سلامة واجهة إدخال أو إذن مرفق؛ اختبر مسارًا مصدقًا ومرفوضًا حسب الدور من دون كشف بيانات المستخدمين. لا توقف الموقع كحل افتراضي لأخطاء المحتوى أو التخزين.','site-guide-dev-021'
FROM explanation_groups WHERE slug='site-developer-guide' ON CONFLICT(import_key) DO NOTHING;

INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,import_key)
SELECT id,NULL,22,'heading','حدود هذا المرجع وكيفية تحديثه','هذا الدليل يصف بنية المصدر عند صياغته ويتغير مع تحديث الموقع. عند الاختلاف، تُقدم ملفات GitHub على الكلام القديم، ثم تُراجع حالة Render وقاعدة البيانات والعقود الفعلية. روابط الملفات ومسارات API المذكورة مرجع تقني وليس تصريحًا مفتوحًا باستعمالها. لا تتضمن الوثيقة رموز وصول أو كلمات مرور أو DATABASE_URL. أي تعديل في الدليل يجب أن يكون مقصودًا وواضح التاريخ ويمكن مراجعته في Git.','site-guide-dev-022'
FROM explanation_groups WHERE slug='site-developer-guide' ON CONFLICT(import_key) DO NOTHING;
