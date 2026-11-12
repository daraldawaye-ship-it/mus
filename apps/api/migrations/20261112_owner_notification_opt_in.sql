-- Owner notifications are opt-in per template, independent from general managers.
-- Existing template settings remain intact; no owner subscription is assumed.
ALTER TABLE notification_settings
  ADD COLUMN notify_owner boolean NOT NULL DEFAULT false;
