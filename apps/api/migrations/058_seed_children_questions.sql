-- One-time seed of 20 public questions. Existing questions and other tenants remain untouched.
-- The platform owner is the author. On a new empty test schema no owner exists, so no seed is inserted.
WITH source(question,answer1,answer2,answer3,answer4,correct_answer) AS (
 VALUES
 ('كم عدد سور القرآن الكريم؟', '110 سور', '112 سورة', '114 سورة', '120 سورة', 3),
 ('كم عدد كواكب المجموعة الشمسية؟', '8 كواكب', '7 كواكب', '9 كواكب', '10 كواكب', 1),
 ('من هو النبي الذي كانت معجزته الناقة؟', 'موسى عليه السلام', 'صالح عليه السلام', 'يونس عليه السلام', 'إبراهيم عليه السلام', 2),
 ('من هو أول الأنبياء؟', 'نوح عليه السلام', 'يوسف عليه السلام', 'موسى عليه السلام', 'آدم عليه السلام', 4),
 ('من هو النبي الذي ابتلعه الحوت؟', 'يونس عليه السلام', 'هود عليه السلام', 'يوسف عليه السلام', 'إسماعيل عليه السلام', 1),
 ('في أي مدينة وُلد النبي محمد صلى الله عليه وسلم؟', 'المدينة المنورة', 'الطائف', 'مكة المكرمة', 'القدس', 3),
 ('كم عدد الصلوات المفروضة في اليوم والليلة؟', 'ثلاث صلوات', 'خمس صلوات', 'أربع صلوات', 'ست صلوات', 2),
 ('في أي شهر يصوم المسلمون صيام الفريضة؟', 'شعبان', 'شوال', 'محرم', 'رمضان', 4),
 ('ما اسم الكتاب الذي أُنزل على النبي محمد صلى الله عليه وسلم؟', 'القرآن الكريم', 'التوراة', 'الإنجيل', 'الزبور', 1),
 ('إلى أي مدينة هاجر النبي محمد صلى الله عليه وسلم من مكة؟', 'الطائف', 'القدس', 'المدينة المنورة', 'صنعاء', 3),
 ('ما اسم الكوكب الذي نعيش عليه؟', 'المشتري', 'الأرض', 'المريخ', 'زحل', 2),
 ('ما اسم أقرب نجم إلى الأرض؟', 'نجم الشعرى', 'القمر', 'كوكب الزهرة', 'الشمس', 4),
 ('ما الكوكب الذي يُعرف بالكوكب الأحمر؟', 'المريخ', 'عطارد', 'زحل', 'نبتون', 1),
 ('كم عدد أيام الأسبوع؟', '5 أيام', '6 أيام', '7 أيام', '8 أيام', 3),
 ('كم عدد أشهر السنة الميلادية؟', '10 أشهر', '12 شهرًا', '11 شهرًا', '13 شهرًا', 2),
 ('ما اسم القمر الطبيعي الذي يدور حول الأرض؟', 'الشمس', 'المريخ', 'زحل', 'القمر', 4),
 ('كم عدد أصابع اليد الواحدة لدى معظم الناس، مع الإبهام؟', '5 أصابع', '4 أصابع', '6 أصابع', '7 أصابع', 1),
 ('ما الحيوان الذي يُلقّب بسفينة الصحراء؟', 'الحصان', 'الفيل', 'الجمل', 'الغزال', 3),
 ('ما العضو الذي يضخ الدم في جسم الإنسان؟', 'الرئة', 'القلب', 'المعدة', 'الكبد', 2),
 ('ما اللون الذي ينتج عند خلط اللونين الأزرق والأصفر في الألوان المائية؟', 'الأحمر', 'البرتقالي', 'البنفسجي', 'الأخضر', 4)
),
owner_user AS (
 SELECT id,display_name FROM users WHERE owner AND NOT archived ORDER BY id LIMIT 1
),
inserted AS (
 INSERT INTO questions (
   company_id, category, priority, question,
   answer1, answer2, answer3, answer4,
   option_count, correct_answer, points, active, created_by
 )
 SELECT NULL, 'أسئلة للأطفال', 1, source.question,
   source.answer1, source.answer2, source.answer3, source.answer4,
   4, source.correct_answer, 1, TRUE, owner_user.id
 FROM source CROSS JOIN owner_user
 WHERE NOT EXISTS (
   SELECT 1 FROM questions q
   WHERE q.company_id IS NULL AND q.category = 'أسئلة للأطفال'
     AND q.question = source.question
 )
 RETURNING id,created_by,category,priority,question,
   answer1,answer2,answer3,answer4,correct_answer,points,active
)
INSERT INTO audit_events (
 actor_id,actor_name,scope,company_id,action,target_type,
 target_id,before_value,after_value
)
SELECT inserted.created_by,owner_user.display_name,'public',NULL,'question.create',
 'question',inserted.id,NULL,
 jsonb_build_object('category',inserted.category,'priority',inserted.priority,
 'question',inserted.question,
 'options',jsonb_build_array(inserted.answer1,inserted.answer2,inserted.answer3,inserted.answer4),
 'correctAnswer',inserted.correct_answer,'points',inserted.points,'active',inserted.active)
FROM inserted JOIN owner_user ON owner_user.id = inserted.created_by;
