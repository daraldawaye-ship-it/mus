-- Reuse the existing direct-recipient inquiry notifications (public and company).
-- Default delay applies to newly created company scopes without overriding
-- later explicit notification_settings choices (including NULL to disable).
ALTER TABLE notification_templates
  ADD COLUMN IF NOT EXISTS default_min_interval_hours integer
  CHECK (default_min_interval_hours IS NULL OR default_min_interval_hours > 0);

UPDATE notification_templates
SET name = 'استفسارات بحاجة الى رد',
    default_latest_only = true,
    default_min_interval_hours = 12
WHERE code IN ('INQUIRY_UNANSWERED_COMPANY','INQUIRY_UNANSWERED_PUBLIC');
