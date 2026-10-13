-- Phone-first identity readiness. Old email-only accounts and their sessions survive.
-- Email is optional, but supplied addresses remain unique. Multiple blank emails are allowed.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_nonempty_unique ON users(email) WHERE email <> '';

-- Only one account may claim a phone login key. For legacy duplicate phone
-- numbers, do not guess ownership: they keep email login until corrected.
ALTER TABLE users ADD COLUMN phone_login_key text;
ALTER TABLE users ADD COLUMN phone_verified_at timestamptz;
UPDATE users u SET phone_login_key=u.phone
WHERE u.phone <> ''
  AND NOT EXISTS (
    SELECT 1 FROM users other WHERE other.phone=u.phone AND other.id<>u.id
  );
ALTER TABLE users ADD CONSTRAINT users_phone_login_key_shape
  CHECK (phone_login_key IS NULL OR
    (phone_login_key=phone AND phone_login_key ~ '^[+]?[0-9]{3,20}));
CREATE UNIQUE INDEX users_phone_login_key_unique ON users(phone_login_key)
WHERE phone_login_key IS NOT NULL;
COMMENT ON COLUMN users.phone_login_key IS 'Unique sign-in lookup only. This is NOT proof of phone ownership.';
COMMENT ON COLUMN users.phone_verified_at IS 'NULL until a real SMS OTP flow proves phone possession; future implementations must clear on phone change.';
));
CREATE UNIQUE INDEX users_phone_login_key_unique ON users(phone_login_key)
WHERE phone_login_key IS NOT NULL;
COMMENT ON COLUMN users.phone_login_key IS 'Unique sign-in lookup only. This is NOT proof of phone ownership.';
COMMENT ON COLUMN users.phone_verified_at IS 'NULL until a real SMS OTP flow proves phone possession; future implementations must clear on phone change.';
