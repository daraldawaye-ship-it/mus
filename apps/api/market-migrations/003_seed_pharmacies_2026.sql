-- User-supplied pharmacy directory snapshot (2026-11-02). No claim that
-- listed hours/phones are currently verified. Each branch is a distinct card.
-- Import is idempotent and avoids changes to existing manual edits.
-- System attribution (id=0) never represents a real employee account.
-- Keep only the first valid local mobile per pharmacy: nine digits beginning
-- with 7. Do not store any landline, extra contact, incomplete or country code.
INSERT INTO users(id,display_name) VALUES (0,'دليل السوق — إدخال إداري')
ON CONFLICT(id) DO NOTHING;
WITH supplied(name,address,phones,source_domain,notes) AS (
 VALUES
 ('صيدليات عصام المركزية — فرع الأصبخي','الأصبخي، أمام مستشفى اليمن السعيد','01677780,782266996','daleel.ye','24h'),
 ('صيدليات عصام المركزية — فرع شارع الزبيري','شارع الزبيري، أمام بنك اليمن والكويت','01200210,772266995','facebook.com','24h'),
 ('صيدليات عصام المركزية — فرع جولة الرويشان','جولة الرويشان، جوار المستشفى اليمني الفرنسي','01210044,782266919','facebook.com','24h'),
 ('صيدليات عصام المركزية — فرع شارع الستين','شارع الستين، أمام بوابة طوارئ المستشفى الأوروبي','01402888,772266900','daleel.ye','24h'),
 ('صيدليات عصام المركزية — فرع شارع بغداد','شارع بغداد، جوار مستشفى المتوكل','01478466,782266997','daleel.ye','24h'),
 ('صيدليات عصام المركزية — فرع فج عطان - الستين','فج عطان، الستين، جوار المستشفى الأهلي','01442200,782266920','daleel.ye','24h'),
 ('صيدليات عصام المركزية — فرع حدة','حدة، شارع صفر تقاطع شارع إيران','01412999,782266994','daleel.ye','24h'),
 ('صيدليات عصام المركزية — فرع سعوان','سعوان، جولة النصر','01301111,782266998','daleel.ye','24h'),
 ('صيدليات عصام المركزية — فرع جدر','جدر، أمام مركز الأمناء الطبي','01389389,772266919','daleel.ye','24h'),
 ('صيدليات عصام المركزية — فرع حزيز','حزيز، قبل سوق حزيز','01693666,782266969','daleel.ye','24h'),
 ('صيدليات ابن حيان — فرع التحرير','التحرير، أمام سينما بلقيس','01495056','facebook.com',''),
 ('صيدليات ابن حيان — فرع شارع الزبيري','شارع الزبيري، أمام بنك اليمن الدولي','01534488','facebook.com',''),
 ('صيدليات ابن حيان — فرع جولة حدة','جولة حدة، بالاتجاه نحو الفندق','01415145','facebook.com',''),
 ('صيدليات ابن حيان — فرع حدة المدينة','حدة المدينة، جوار قاعة سكران','014322238','facebook.com',''),
 ('صيدليات ابن حيان — فرع شارع تعز','شارع تعز، جوار مستشفى ناصر','01616717','facebook.com',''),
 ('صيدليات ابن حيان — فرع شارع بغداد','شارع بغداد، أمام مستشفى المتوكل','01537566','facebook.com',''),
 ('صيدليات مدينة سام — فرع شارع الستين الجنوبي','شارع الستين الجنوبي','776126401','instagram.com',''),
 ('صيدلية النهدي المركزية — فرع شارع 14 أكتوبر','شارع 14 أكتوبر، قبل مطعم نجوم الشام، جوار النقابة','','sanaamedical.net',''),
 ('الصيدلية الاستشارية العالمية','شارع تعز، جوار أيلول للتصوير','775777765','daleel.ye',''),
 ('الصيدلية السويسرية','شارع تعز، أمام فندق الشام','01613099','daleel.ye',''),
 ('الصيدلية العصرية','شارع هائل','01219172','daleel.ye',''),
 ('الصيدلية الماسية','شارع تعز، حزيز','01697634','daleel.ye',''),
 ('الصيدلية المركزية','شارع حدة','01418000','daleel.ye',''),
 ('صيدلية 7 يوليو','شارع الحرية','01226378','daleel.ye',''),
 ('صيدلية 22 مايو','سوق شميلة','01613174','daleel.ye',''),
 ('صيدلية 2010','شارع الرباط','01205413','daleel.ye',''),
 ('صيدلية ابن النفيس — شارع القيادة / التحرير','شارع القيادة، التحرير','01285530','facebook.com',''),
 ('صيدلية ابن النفيس — شارع خولان','شارع خولان','01501321','facebook.com',''),
 ('صيدلية ابن الهيثم — حي الإذاعة','حي الإذاعة','01273920','facebook.com',''),
 ('صيدلية ابن الهيثم الدولية','شارع الزبيري','01506639','facebook.com',''),
 ('صيدلية ابن خلدون','شارع المطار','01323460','facebook.com',''),
 ('صيدلية ابن رشد','شارع الجامعة العربية','01226157','facebook.com',''),
 ('صيدلية ابن سيناء','شارع الزبيري','01219666','facebook.com',''),
 ('صيدلية ابن مالك','شارع هائل','01205464','facebook.com',''),
 ('صيدلية أبو أحمد للأدوية','شارع القصر الجمهوري','01284946','facebook.com',''),
 ('صيدلية أبو أدهم','شارع الخمسين','771589344','facebook.com',''),
 ('صيدلية أبو بشير','بيت بوس','770735353','facebook.com',''),
 ('صيدلية أبو حمزة','حي الكويت، شارع الزراعة','773677799','facebook.com',''),
 ('صيدلية أبو رامي','مذبح، الشارع العام','01371007','facebook.com',''),
 ('صيدلية أبو ربيع','شعوب، شارع الجمهورية','01238014','facebook.com',''),
 ('صيدلية الحياة الحديثة','صنعاء الدائري، جولة الكتاب، تقاطع الدائري مع الرقاص','780129922,774688218,01218313','daleel.ye',''),
 ('الصيدلية المتحدة (United Pharmacy)','جولة الرويشان، بجانب هابي لاند، مقابل يمن مول','770440611,738808083','google.com',''),
 ('صيدلية مستشفى العاقل','شارع الزبيري، جولة عصر','01400999','instagram.com','partial: 775231...'),
 ('صيدلية أبو وائل','شارع الحربي','01674850','yellowpagesyemen.com',''),
 ('صيدلية الأكرم للأدوية والمستلزمات','شارع الشراعي','','daleel.ye',''),
 ('صيدلية أمل رويال','جولة عمران، أمام المستشفى العربي الدولي','','daleel.ye',''),
 ('الصيدلية الأهلية','حزيز، جوار بنك','','sanaamedical.net',''),
 ('صيدلية أيمن 3','شارع تعز، جوار مستشفى','','sanaamedical.net',''),
 ('صيدلية الجبلي','الأصبحي، شارع المقالح، جوار مستشفى الزماني','','sanaamedical.net',''),
 ('صيدلية الوليد فارما','الأصبحي، شارع المقالح','','sanaamedical.net',''),
 ('صيدلية سام 4','الأصبحي، شارع المقالح، أمام السامدي','','sanaamedical.net',''),
 ('صيدلية القمر','حي الأصبحي، شارع المقالح، أمام الكريمي','','sanaamedical.net',''),
 ('صيدلية الجهمي','الأصبحي، سوق المقالح، أمام مستشفى اليمن','','sanaamedical.net',''),
 ('صيدلية التهامي','تقاطع شارع بينون مع شارع بيحان، جوار مدارس شموخ','','sanaamedical.net',''),
 ('صيدلية شخب عمار','شارع تعز، أمام مستشفى الروماني','','sanaamedical.net',''),
 ('صيدلية دار الأمان','نقم، شارع التوحيد، جوار مركز التوحيد','','sanaamedical.net',''),
 ('أدوية أبو خليل الحديثة','شارع بينون، جوار الفلفلة','','sanaamedical.net',''),
 ('دار الصيدلة','شارع تعز، جولة المرور','','sanaamedical.net',''),
 ('صيدلية ساك','شارع تعز، جوار بازرعة','','sanaamedical.net',''),
 ('صيدلية الغزالي','شارع تعز، أمام كاك بنك','','sanaamedical.net',''),
 ('صيدلية سحاب','شارع تعز، جولة 45، جوار البنك اليمني للإنشاء','','sanaamedical.net',''),
 ('صيدلية الامتياز','الدائري الغربي، جولة كنتاكي، جوار فندق سبأ','','sanaamedical.net',''),
 ('صيدلية الدالي 1','الدائري الغربي، جولة كنتاكي','','sanaamedical.net',''),
 ('صيدلية الدواء الحديثة','شارع الدائري الغربي، أمام مكتبة الجيل','','sanaamedical.net',''),
 ('صيدلية نيو سكان','شارع الزبيري، جوار مستشفى المغربي','','sanaamedical.net',''),
 ('صيدلية سما الحياة','شارع الزبيري، خلف المختبرات','','sanaamedical.net',''),
 ('صيدلية البغدادي','هائل، شارع 16، مقابل مطاعم الهلال','','sanaamedical.net',''),
 ('صيدلية اورنج فارما','هائل، شارع 16، جوار النجم','','sanaamedical.net',''),
 ('صيدلية دار الهدى للأدوية','هائل، شارع 16، جوار بهارات الجودة','','sanaamedical.net',''),
 ('صيدلية العاقل الحديثة','هائل، شارع 16','','sanaamedical.net','')
), prepared AS (
 SELECT s.*,
  lower(regexp_replace(translate(s.name,'أإآٱى','ااااي'),'[[:space:]]+',' ','g')) AS normalized,
  md5('market-pharmacy-list-2026-11-02:' || s.name) AS uid,
  (SELECT trim(m.value) FROM unnest(string_to_array(s.phones,',')) WITH ORDINALITY AS m(value,seq)
    WHERE trim(m.value) ~ '^7[0-9]{8}$' ORDER BY m.seq LIMIT 1) AS mobile_phone,
  (SELECT trim(m.value) FROM unnest(string_to_array(s.phones,',')) WITH ORDINALITY AS m(value,seq)
    WHERE trim(m.value) ~ '^0[0-9]{7} ORDER BY m.seq LIMIT 1) AS landline_phone
 FROM supplied s
)
INSERT INTO medicine_market_cards(kind,name,normalized_name,data,status,created_by,idempotency_key)
SELECT 'pharmacy',name,normalized,
 jsonb_strip_nulls(jsonb_build_object(
   'phone',mobile_phone,
   'landlinePhone',landline_phone,
   'address',address,
   'countryCode','YE','governorateCode','YE-AMANA','cityCode','YE-AMANA-SANAA',
   'sourceNotes','الاسم والموقع والأرقام وردت من قائمة المالك بتاريخ 02/11/2026؛ المصدر المذكور ' ||
      source_domain || ' دون رابط مباشر؛ لم يُتحقق من البيانات مباشرة. ' ||
      'تم اختيار رقم موبايل واحد ورقم هاتف ثابت واحد كحد أقصى بصيغتهما المحلية، دون مفتاح دولي.' ||
      CASE WHEN notes='24h' THEN ' وُصفت الصيدلية بأنها تعمل 24 ساعة؛ غير مؤكد.'
        WHEN notes LIKE 'partial:%' THEN ' رُفض الرقم الناقص؛ لم يتم إدخاله.'
        ELSE '' END
 )),
 'published',0,
 (substring(uid,1,8)||'-'||substring(uid,9,4)||'-'||substring(uid,13,4)||'-'||
  substring(uid,17,4)||'-'||substring(uid,21,12))::uuid
FROM prepared
ON CONFLICT DO NOTHING;
 ORDER BY m.seq LIMIT 1) AS landline_phone
 FROM supplied s
)
INSERT INTO medicine_market_cards(kind,name,normalized_name,data,status,created_by,idempotency_key)
SELECT 'pharmacy',name,normalized,
 jsonb_strip_nulls(jsonb_build_object(
   'phone',mobile_phone,
   'landlinePhone',landline_phone,
   'address',address,
   'countryCode','YE','governorateCode','YE-AMANA','cityCode','YE-AMANA-SANAA',
   'sourceNotes','الاسم والموقع والأرقام وردت من قائمة المالك بتاريخ 02/11/2026؛ المصدر المذكور ' ||
      source_domain || ' دون رابط مباشر؛ لم يُتحقق من البيانات مباشرة. ' ||
      'تم اختيار رقم موبايل واحد ورقم هاتف ثابت واحد كحد أقصى بصيغتهما المحلية، دون مفتاح دولي.' ||
      CASE WHEN notes='24h' THEN ' وُصفت الصيدلية بأنها تعمل 24 ساعة؛ غير مؤكد.'
        WHEN notes LIKE 'partial:%' THEN ' رُفض الرقم الناقص؛ لم يتم إدخاله.'
        ELSE '' END
 )),
 'published',0,
 (substring(uid,1,8)||'-'||substring(uid,9,4)||'-'||substring(uid,13,4)||'-'||
  substring(uid,17,4)||'-'||substring(uid,21,12))::uuid
FROM prepared
ON CONFLICT DO NOTHING;
