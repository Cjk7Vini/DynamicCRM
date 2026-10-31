-- Migratie 027: inloggedrag van marketing-accounts bijhouden, net als bij de
-- dashboard-gebruikers. last_seen_at = laatst actief (hooguit 1x per minuut
-- bijgewerkt), login_events = elke login (voor tellingen per maand).
-- Draai eenmalig in Neon.
ALTER TABLE marketing.accounts
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS marketing.login_events (
  id           BIGSERIAL PRIMARY KEY,
  account_id   INTEGER NOT NULL,
  workspace_id INTEGER NOT NULL,
  ingelogd_op  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS marketing_login_events_account_idx
  ON marketing.login_events (account_id, ingelogd_op);
