-- Migratie 009: dagelijkse snapshot van het totale volgersaantal per klant.
-- Hiermee kunnen we NETTO nieuwe volgers berekenen (eind - begin), wat Meta zelf
-- niet teruggeeft. Draai dit eenmalig in Neon.
CREATE TABLE IF NOT EXISTS marketing.follower_snapshots (
  id SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL,
  client_id INTEGER NOT NULL,
  day DATE NOT NULL,
  followers INTEGER,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (client_id, day)
);
CREATE INDEX IF NOT EXISTS follower_snapshots_client_day_idx
  ON marketing.follower_snapshots (client_id, day);
