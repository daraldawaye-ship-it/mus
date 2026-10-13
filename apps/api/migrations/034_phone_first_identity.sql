-- Phone-first identity readiness, preserving legacy email-only accounts.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_nonempty_unique ON users(email) WHERE email <> '';

-- Ambiguous historical duplicate numbers cannot be mapped to a login identity.
ALTER TABLE users ADD COLUMN phone_login_key text;
ALTER TABLE users ADD COLUMN phone_verified_at timestamptz;
UPDATE users u SET phone_login_key=u.phone
WHERE u.phone <> ''
  AND NOT EXISTS (
    SELECT 1 FROM users other WHERE other.phone=u.phone AND other.id<>u.id
  );
ALTER TABLE users ADD CONSTRAINT users_phone_login_key_shape
  CHECK (phone_login_key IS NULL OR
    (phone_login_key=phone AND phone_login_key ~ '^[+]?[0-9]{3,20}$'));
CREATE UNIQUE INDEX users_phone_login_key_unique ON users(phone_login_key)
WHERE phone_login_key IS NOT NULL;
COMMENT ON COLUMN users.phone_login_key IS 'Unique login key only; phone ownership is not yet proven by SMS';
COMMENT ON COLUMN users.phone_verified_at IS 'NULL until an actual SMS verification; clear whenever phone changes';
