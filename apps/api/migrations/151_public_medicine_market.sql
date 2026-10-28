-- The public medicine directory is independent of company accounting and stock.
INSERT INTO page_registry(key) VALUES ('public.medicine-market'),('public.medicine-market-review'),('public.medicine-market-contributions'),('public.medicine-market-points') ON CONFLICT DO NOTHING;
CREATE TABLE medicine_market_cards (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 kind text NOT NULL CHECK(kind IN ('medicine','composition','scientific-name','dosage-form','pharmacy','wholesaler','agent','manufacturer','doctor','hospital','clinic','college')),
 name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 300),
 normalized_name text NOT NULL,
 data jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(data)='object'),
 status text NOT NULL CHECK(status IN ('pending','published','rejected')),
 archived boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_by integer NOT NULL REFERENCES users(id),
 idempotency_key uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(created_by,idempotency_key)
);
CREATE UNIQUE INDEX medicine_market_name_unique ON medicine_market_cards(kind,normalized_name) WHERE status<>'rejected';
CREATE INDEX medicine_market_cards_browse ON medicine_market_cards(kind,id DESC) WHERE status='published' AND NOT archived;
CREATE TABLE medicine_market_contributions (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 card_id integer NOT NULL REFERENCES medicine_market_cards(id),
 field_key text NOT NULL,
 previous_value jsonb NOT NULL,
 proposed_value jsonb NOT NULL,
 source text NOT NULL DEFAULT '' CHECK(length(source)<=1000),
 author_id integer NOT NULL REFERENCES users(id),
 idempotency_key uuid NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','conflict')),
 published boolean NOT NULL DEFAULT false,
 awarded_points integer NOT NULL DEFAULT 0 CHECK(awarded_points BETWEEN 0 AND 100000),
 reviewer_id integer REFERENCES users(id), reason text NOT NULL DEFAULT '' CHECK(length(reason)<=1000),
 created_at timestamptz NOT NULL DEFAULT now(), reviewed_at timestamptz,
 UNIQUE(author_id,idempotency_key)
);
CREATE INDEX medicine_market_contributions_queue ON medicine_market_contributions(status,id);
CREATE INDEX medicine_market_contributions_author ON medicine_market_contributions(author_id,id DESC);
CREATE INDEX medicine_market_contributions_card ON medicine_market_contributions(card_id,id DESC);
CREATE TABLE medicine_market_policies (
 kind text NOT NULL, field_key text NOT NULL,
 add_points integer NOT NULL DEFAULT 0 CHECK(add_points BETWEEN 0 AND 100000),
 edit_points integer NOT NULL DEFAULT 0 CHECK(edit_points BETWEEN 0 AND 100000),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 PRIMARY KEY(kind,field_key)
);
CREATE TABLE medicine_market_points (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 contribution_id integer NOT NULL UNIQUE REFERENCES medicine_market_contributions(id),
 user_id integer NOT NULL REFERENCES users(id),
 points integer NOT NULL CHECK(points BETWEEN 0 AND 100000),
 policy_snapshot jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX medicine_market_points_user ON medicine_market_points(user_id,id DESC);
CREATE FUNCTION protect_medicine_market_points() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Market points history is immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER medicine_market_points_immutable BEFORE UPDATE OR DELETE ON medicine_market_points FOR EACH ROW EXECUTE FUNCTION protect_medicine_market_points();
CREATE TABLE medicine_market_comments (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 card_id integer NOT NULL REFERENCES medicine_market_cards(id),
 author_id integer NOT NULL REFERENCES users(id),
 text text NOT NULL CHECK(length(trim(text)) BETWEEN 1 AND 2000),
 status text NOT NULL CHECK(status IN ('pending','approved','rejected')),
 idempotency_key uuid NOT NULL,
 reviewer_id integer REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(), reviewed_at timestamptz,
 UNIQUE(author_id,idempotency_key)
);
CREATE INDEX medicine_market_comments_card ON medicine_market_comments(card_id,id DESC);
CREATE INDEX medicine_market_comments_pending ON medicine_market_comments(status,id);
CREATE TABLE medicine_market_reactions (
 card_id integer NOT NULL REFERENCES medicine_market_cards(id),
 user_id integer NOT NULL REFERENCES users(id),
 liked boolean NOT NULL DEFAULT false,
 rating smallint CHECK(rating BETWEEN 1 AND 5),
 PRIMARY KEY(card_id,user_id)
);
