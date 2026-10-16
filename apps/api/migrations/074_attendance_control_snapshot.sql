-- Freeze automatic attendance cutoff at check-in. Existing open sessions retain 16h.
ALTER TABLE attendance_records ADD COLUMN automatic_checkout_hours integer NOT NULL DEFAULT 16
CHECK (automatic_checkout_hours BETWEEN 1 AND 48);
