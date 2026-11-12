-- A notification type is reviewed only when the manager explicitly marks it so.
-- Existing types remain unreviewed in both public and company scopes.
ALTER TABLE notification_settings ADD COLUMN reviewed boolean NOT NULL DEFAULT false;
