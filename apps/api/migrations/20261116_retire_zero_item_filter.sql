-- Retire only the obsolete switch; preserve preset identity and all other options.
UPDATE company_item_options_presets
SET filters = filters - 'excludeZero'
WHERE filters ? 'excludeZero';
