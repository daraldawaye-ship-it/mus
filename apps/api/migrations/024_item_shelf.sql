-- Item picking shelf shown with sale invoice stock quantity.
ALTER TABLE items ADD COLUMN shelf text NOT NULL DEFAULT '' CHECK (length(shelf)<=100);
