-- Voluntary referral records in the isolated public medicine market.
-- No invitation message is sent by the platform.
CREATE TABLE IF NOT EXISTS market_friend_referrals (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 referred_by integer NOT NULL REFERENCES users(id),
 target_phone varchar(24) NOT NULL,
 note varchar(1000) NOT NULL DEFAULT '',
 category varchar(80) NOT NULL,
 card_id integer REFERENCES medicine_market_cards(id) ON DELETE SET NULL,
 card_name_at_creation varchar(300),
 idempotency_key uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(referred_by,idempotency_key)
);
CREATE INDEX IF NOT EXISTS market_friend_referrals_author_recent
 ON market_friend_referrals(referred_by,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS market_friend_referrals_recent
 ON market_friend_referrals(created_at DESC,id DESC);
