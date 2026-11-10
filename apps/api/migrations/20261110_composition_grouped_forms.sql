-- Consolidate only composition dosage forms; company item forms retain their precise labels.
-- Existing composition IDs and item links are unchanged.
ALTER TABLE item_compositions DROP CONSTRAINT IF EXISTS composition_product_form_valid;

UPDATE item_compositions
SET product_form = CASE
  WHEN product_form IN ('اقراص','كبسول') THEN 'اقراص/كبسول'
  WHEN product_form IN ('مرهم','كريم','جل') THEN 'مرهم/كريم/جل'
  ELSE product_form END,
  revision = revision + 1,
  updated_at = GREATEST(updated_at,clock_timestamp())
WHERE product_form IN ('اقراص','كبسول','مرهم','كريم','جل');

ALTER TABLE item_compositions ADD CONSTRAINT composition_product_form_valid CHECK (
  product_form IN (
    'اقراص/كبسول','مرهم/كريم/جل','شراب','امبول','فيال','محلول وريدي','محلول خارجي',
    'قطر عين/اذن','مرهم عين','قطر شرب','فيال شراب','تحاميل','قطعه','بخاخ',
    'جل فم','دش مهبلي','سائل','فوار','مصوص',
    'مضمضه','بودر','شرائح','صابون','شامبو','حليب بودر','زيت',
    'تيوب','غذاء اكفال','حزام/رباط','قطعة','عام'
  )
);
