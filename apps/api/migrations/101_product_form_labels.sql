-- Correct legacy typo in item/composition pharmaceutical forms and add eye ointment.
-- Drop old constraints before converting stored values to avoid rejecting the corrected label.
ALTER TABLE items DROP CONSTRAINT IF EXISTS item_product_form_valid;
ALTER TABLE item_compositions DROP CONSTRAINT IF EXISTS composition_product_form_valid;

-- One-time label correction: master-identity guards must not reject the migration.
ALTER TABLE items DISABLE TRIGGER USER;
UPDATE items SET product_form='فيال شراب' WHERE product_form='فبال شراب';
ALTER TABLE items ENABLE TRIGGER USER;
UPDATE item_compositions SET product_form='فيال شراب' WHERE product_form='فبال شراب';

ALTER TABLE items ADD CONSTRAINT item_product_form_valid CHECK (
  product_form IN (
    'اقراص','كبسول','شراب','امبول','فيال','محلول وريدي','محلول خارجي',
    'قطر عين/اذن','مرهم عين','قطر شرب','فيال شراب','تحاميل','قطعه','بخاخ',
    'مرهم','كريم','جل','جل فم','دش مهبلي','سائل','فوار','مصوص',
    'مضمضه','بودر','شرائح','صابون','شامبو','حليب بودر','زيت',
    'تيوب','غذاء اكفال','حزام/رباط','قطعة','عام'
  )
);
ALTER TABLE item_compositions ADD CONSTRAINT composition_product_form_valid CHECK (
  product_form IN (
    'اقراص','كبسول','شراب','امبول','فيال','محلول وريدي','محلول خارجي',
    'قطر عين/اذن','مرهم عين','قطر شرب','فيال شراب','تحاميل','قطعه','بخاخ',
    'مرهم','كريم','جل','جل فم','دش مهبلي','سائل','فوار','مصوص',
    'مضمضه','بودر','شرائح','صابون','شامبو','حليب بودر','زيت',
    'تيوب','غذاء اكفال','حزام/رباط','قطعة','عام'
  )
);
