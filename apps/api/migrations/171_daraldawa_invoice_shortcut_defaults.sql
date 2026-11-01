-- Company 2 (Dar Aldawa): allow first-access, permission-gated invoice
-- shortcuts without overwriting existing personal choices.
-- Per-key marker makes the default a one-time suggestion: after the user
-- removes a shortcut via PUT /my-shortcuts, it must not return by itself.
ALTER TABLE user_page_shortcuts
  ADD COLUMN invoice_defaults_seen text[] NOT NULL DEFAULT '{}'::text[]
  CHECK (invoice_defaults_seen <@ ARRAY[
    'company.sale-new','company.purchase-new'
  ]::text[]);
