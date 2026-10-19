-- Shared selectable item / composition form; users can override all inferred values.
-- "عام" is the safe fallback when free-text names cannot identify a form.
ALTER TABLE items ADD COLUMN product_form text NOT NULL DEFAULT 'عام';
ALTER TABLE item_compositions ADD COLUMN product_form text NOT NULL DEFAULT 'عام';

ALTER TABLE items ADD CONSTRAINT item_product_form_valid CHECK (
  product_form IN (
    'اقراص','كبسول','شراب','امبول','فيال','محلول وريدي','محلول خارجي',
    'قطر عين/اذن','قطر شرب','فبال شراب','تحاميل','قطعه','بخاخ',
    'مرهم','كريم','جل','جل فم','دش مهبلي','سائل','فوار','مصوص',
    'مضمضه','بودر','شرائح','صابون','شامبو','حليب بودر','زيت',
    'تيوب','غذاء اكفال','حزام/رباط','قطعة','عام'
  )
);
ALTER TABLE item_compositions ADD CONSTRAINT composition_product_form_valid CHECK (
  product_form IN (
    'اقراص','كبسول','شراب','امبول','فيال','محلول وريدي','محلول خارجي',
    'قطر عين/اذن','قطر شرب','فبال شراب','تحاميل','قطعه','بخاخ',
    'مرهم','كريم','جل','جل فم','دش مهبلي','سائل','فوار','مصوص',
    'مضمضه','بودر','شرائح','صابون','شامبو','حليب بودر','زيت',
    'تيوب','غذاء اكفال','حزام/رباط','قطعة','عام'
  )
);

-- Deliberately conservative rule order: specific routes before broad forms.
-- Infer separately for item and composition; never force them to agree.
-- This one-time helper is removed after the initial existing-record backfill.
CREATE FUNCTION _initial_product_form_from_name(input_name text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE
 WHEN lower(input_name) ~ '(حليب\s*(بودر|مسحوق)|milk\s*(powder|formula)|infant\s*formula)' THEN 'حليب بودر'
 WHEN lower(input_name) ~ '(غذاء\s*(اطفال|أطفال|اكفال)|baby\s*food|infant\s*food)' THEN 'غذاء اكفال'
 WHEN lower(input_name) ~ '(حزام|رباط|belt|bandage|support\s*brace)' THEN 'حزام/رباط'
 WHEN lower(input_name) ~ '(دش\s*مهبل|vaginal\s*(douche|wash))' THEN 'دش مهبلي'
 WHEN lower(input_name) ~ '(جل\s*(فم|للفم)|oral\s*gel|mouth\s*gel)' THEN 'جل فم'
 WHEN lower(input_name) ~ '(قطر[ةا]?\s*(عين|اذن|أذن)|eye\s*drops?|ear\s*drops?|ophthalmic|otic\s*drops?)' THEN 'قطر عين/اذن'
 WHEN lower(input_name) ~ '(قطر[ةا]?\s*(شرب|فم|للأطفال)|oral\s*drops?|drops?\s*oral)' THEN 'قطر شرب'
 WHEN lower(input_name) ~ '(فيال\s*شراب|vial\s*syrup|dry\s*syrup)' THEN 'فبال شراب'
 WHEN lower(input_name) ~ '(محلول\s*(وريدي|مغذي|مغذّي|تسريب)|\m(iv|infusion|intravenous)\M)' THEN 'محلول وريدي'
 WHEN lower(input_name) ~ '(محلول\s*(خارجي|موضعي)|external\s*solution|topical\s*solution)' THEN 'محلول خارجي'
 WHEN lower(input_name) ~ '(مضمض[ةه]|غسول\s*فم|mouthwash|oral\s*rinse)' THEN 'مضمضه'
 WHEN lower(input_name) ~ '(شامبو|shampoo)' THEN 'شامبو'
 WHEN lower(input_name) ~ '(صابون|soap)' THEN 'صابون'
 WHEN lower(input_name) ~ '(تحاميل|تحميل[ةه]|suppositor|pessar)' THEN 'تحاميل'
 WHEN lower(input_name) ~ '(كبسول|كبسيل|capsules?|\mcaps?\M|\mcaplet\M)' THEN 'كبسول'
 WHEN lower(input_name) ~ '(اقراص|أقراص|قرص|حبوب|tablets?|\mtabs?\M|\mtbl\M)' THEN 'اقراص'
 WHEN lower(input_name) ~ '(امبول|أمبول|امبوله|أمبولة|ampoules?|\mamp\M)' THEN 'امبول'
 WHEN lower(input_name) ~ '(فيال|vials?)' THEN 'فيال'
 WHEN lower(input_name) ~ '(شراب|syrups?|\msyp\M|suspension|معلق\s*فموي)' THEN 'شراب'
 WHEN lower(input_name) ~ '(مرهم|ointment|unguent)' THEN 'مرهم'
 WHEN lower(input_name) ~ '(كريم|creams?|\mcrm\M)' THEN 'كريم'
 WHEN lower(input_name) ~ '(بخاخ|sprays?|inhalers?|aerosol)' THEN 'بخاخ'
 WHEN lower(input_name) ~ '(فوار|effervescent)' THEN 'فوار'
 WHEN lower(input_name) ~ '(مصوص|مستحلب|lozenges?|troches?)' THEN 'مصوص'
 WHEN lower(input_name) ~ '(شرائح|شريط\s*دواء|strips?|patches?)' THEN 'شرائح'
 WHEN lower(input_name) ~ '(بودر|بودرة|مسحوق|powders?|sachets?|granules?)' THEN 'بودر'
 WHEN lower(input_name) ~ '(جل|gel)' THEN 'جل'
 WHEN lower(input_name) ~ '(زيت|oil)' THEN 'زيت'
 WHEN lower(input_name) ~ '(تيوب|tubes?)' THEN 'تيوب'
 WHEN lower(input_name) ~ '(سائل|liquids?|lotion)' THEN 'سائل'
 WHEN lower(input_name) ~ '(قطعة|قطعه|pieces?|\mpcs?\M)' THEN 'قطعة'
 ELSE 'عام'
 END
$$;

-- A named product often includes a dosage form; composition names may not.
UPDATE items
SET product_form=_initial_product_form_from_name(
  concat_ws(' ',name,english_name,unit1_name,unit2_name)
)
WHERE product_form='عام';
UPDATE item_compositions
SET product_form=_initial_product_form_from_name(
  concat_ws(' ',arabic_name,english_name)
)
WHERE product_form='عام';
DROP FUNCTION _initial_product_form_from_name(text);

-- Comparison is read-only and tenant scoped; no backfill changes accounting.
CREATE INDEX IF NOT EXISTS items_form_composition_idx
  ON items(company_id,composition_id,product_form)
  WHERE composition_id IS NOT NULL;

-- Track this read-only comparison as a first-class company page.
INSERT INTO page_registry(key) VALUES ('company.item-form-differences')
ON CONFLICT DO NOTHING;
INSERT INTO permission_definitions(
  key,page_key,action,name,rule_role,required_permissions
) VALUES(
  'company.item-form-differences:view',
  'company.item-form-differences','view',
  'متابعة اختلاف شكل الصنف والتركيب — عرض',
  'permissions',ARRAY['items.view']::text[]
) ON CONFLICT(key) DO NOTHING;
