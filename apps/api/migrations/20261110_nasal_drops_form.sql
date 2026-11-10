-- Allow nasal drops without inferring or rewriting existing classifications.
ALTER TABLE items DROP CONSTRAINT IF EXISTS item_product_form_valid;
ALTER TABLE items ADD CONSTRAINT item_product_form_valid CHECK (
 product_form IN ('اقراص','كبسول','شراب','امبول','فيال','محلول وريدي','محلول خارجي','قطر عين/اذن','قطر انف','مرهم عين','قطر شرب','فيال شراب','تحاميل','قطعه','بخاخ','مرهم','كريم','جل','جل فم','دش مهبلي','سائل','فوار','مصوص','مضمضه','بودر','شرائح','صابون','شامبو','حليب بودر','زيت','تيوب','غذاء اكفال','حزام/رباط','قطعة','عام')
);
ALTER TABLE item_compositions DROP CONSTRAINT IF EXISTS composition_product_form_valid;
ALTER TABLE item_compositions ADD CONSTRAINT composition_product_form_valid CHECK (
  product_form IN (
    'اقراص/كبسول','مرهم/كريم/جل','شراب','امبول','فيال','محلول وريدي','محلول خارجي',
    'قطر عين/اذن','قطر انف','مرهم عين','قطر شرب','فيال شراب','تحاميل','قطعه','بخاخ',
    'جل فم','دش مهبلي','سائل','فوار','مصوص',
    'مضمضه','بودر','شرائح','صابون','شامبو','حليب بودر','زيت',
    'تيوب','غذاء اكفال','حزام/رباط','قطعة','عام'
  )
);
