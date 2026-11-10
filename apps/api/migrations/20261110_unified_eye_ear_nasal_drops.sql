-- Owner decision: one shared eye/ear/nasal drop label, preserving routes in names.
ALTER TABLE items DROP CONSTRAINT IF EXISTS item_product_form_valid;
UPDATE items SET product_form='قطر عين/اذن/انف',revision=revision+1,updated_at=GREATEST(updated_at,clock_timestamp()) WHERE product_form IN ('قطر عين/اذن','قطر انف');
ALTER TABLE items ADD CONSTRAINT item_product_form_valid CHECK (product_form IN ('اقراص','كبسول','شراب','امبول','فيال','محلول وريدي','محلول خارجي','قطر عين/اذن/انف','مرهم عين','قطر شرب','فيال شراب','تحاميل','قطعه','بخاخ','مرهم','كريم','جل','جل فم','دش مهبلي','سائل','فوار','مصوص','مضمضه','بودر','شرائح','صابون','شامبو','حليب بودر','زيت','تيوب','غذاء اكفال','حزام/رباط','قطعة','عام'));
ALTER TABLE item_compositions DROP CONSTRAINT IF EXISTS composition_product_form_valid;
UPDATE item_compositions SET product_form='قطر عين/اذن/انف',revision=revision+1,updated_at=GREATEST(updated_at,clock_timestamp()) WHERE product_form IN ('قطر عين/اذن','قطر انف');
ALTER TABLE item_compositions ADD CONSTRAINT composition_product_form_valid CHECK (product_form IN ('اقراص/كبسول','مرهم/كريم/جل','شراب','امبول','فيال','محلول وريدي','محلول خارجي','قطر عين/اذن/انف','مرهم عين','قطر شرب','فيال شراب','تحاميل','قطعه','بخاخ','جل فم','دش مهبلي','سائل','فوار','مصوص','مضمضه','بودر','شرائح','صابون','شامبو','حليب بودر','زيت','تيوب','غذاء اكفال','حزام/رباط','قطعة','عام'));
