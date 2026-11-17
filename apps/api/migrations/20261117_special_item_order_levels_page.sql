-- Dedicated read-only follow-up page for configured special item order limits.
INSERT INTO page_registry(key) VALUES ('company.item-order-levels')
ON CONFLICT (key) DO NOTHING;

-- Do not UPDATE notifications: notification identity and history are protected
-- by protect_notification_identity(). Historical alerts are redirected
-- at presentation time by notificationDTO, and new alerts use the new href.
