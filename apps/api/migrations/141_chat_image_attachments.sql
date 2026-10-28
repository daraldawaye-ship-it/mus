-- Private chat images and owner-controlled defaults (both disabled).
CREATE TABLE chat_image_settings (
  id integer PRIMARY KEY DEFAULT 1 CHECK(id=1),
  allow_group_images boolean NOT NULL DEFAULT false,
  allow_direct_images boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1,
  updated_by integer REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO chat_image_settings(id) VALUES(1);

-- Media assets remain private until attached to an accepted message.
ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_purpose_check;
ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_purpose_check
  CHECK(purpose IN ('avatar','item','letterhead','chat'));
ALTER TABLE media_assets ADD CONSTRAINT media_assets_check
  CHECK((purpose='avatar' AND company_id IS NULL)
     OR (purpose IN ('item','letterhead') AND company_id IS NOT NULL)
     OR purpose='chat');

ALTER TABLE chat_messages ADD COLUMN image_id uuid REFERENCES media_assets(id);
ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_text_check;
ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_text_check
  CHECK(length(text) BETWEEN 0 AND 4000 AND text=btrim(text) AND (length(text)>0 OR image_id IS NOT NULL));
CREATE UNIQUE INDEX chat_messages_unique_image ON chat_messages(image_id) WHERE image_id IS NOT NULL;

ALTER TABLE chat_group_messages ADD COLUMN image_id uuid REFERENCES media_assets(id);
ALTER TABLE chat_group_messages DROP CONSTRAINT IF EXISTS chat_group_messages_text_check;
ALTER TABLE chat_group_messages ADD CONSTRAINT chat_group_messages_text_check
  CHECK(length(text) BETWEEN 0 AND 4000 AND text=btrim(text) AND (length(text)>0 OR image_id IS NOT NULL));
CREATE UNIQUE INDEX chat_group_messages_unique_image ON chat_group_messages(image_id) WHERE image_id IS NOT NULL;
