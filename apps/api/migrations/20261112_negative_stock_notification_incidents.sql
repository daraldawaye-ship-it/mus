-- A negative balance episode is unique per company, item and location.
-- Historical notifications stay immutable; only their workflow status changes
-- on confirmed recovery to zero or positive quantity.
CREATE TABLE negative_stock_notification_incidents (
  company_id integer NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  item_id integer NOT NULL,
  location_id integer NOT NULL,
  episode integer NOT NULL DEFAULT 1 CHECK (episode > 0),
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (company_id,item_id,location_id)
);
