-- The card-level nearest expiry date is intentionally independent from stock batch dates.
-- It is set explicitly by a stock adjustment and does not rewrite inventory history.
ALTER TABLE items ADD COLUMN nearest_expiry_date date;
INSERT INTO page_registry(key) VALUES ('company.stock-adjustments')
ON CONFLICT (key) DO NOTHING;
