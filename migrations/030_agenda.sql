-- Migratie 030: To do wordt een agenda (dag-, week- en lijstweergave).
-- Uitbreiding van marketing.client_items (kind 'todo'); bestaande taken blijven gewoon werken.
--   * client_id mag leeg zijn: een interne taak (niet voor een klant).
--   * planned_date / planned_time: wanneer je het doet. due_date blijft de deadline.
--   * duration_min, priority (laag/normaal/hoog), item_type (taak/afspraak).
--   * Herhaling: een reeks is een rij met kind 'todo_series' en recur
--     (daily, weekdays, weekly, biweekly, monthly) en optioneel recur_until.
--     Een aangepaste of afgevinkte keer uit een reeks is een gewone 'todo'-rij met
--     series_id en occ_date (de oorspronkelijke datum). Een overgeslagen keer is
--     een rij met kind 'todo_skip'.
-- Draai eenmalig in Neon.
ALTER TABLE marketing.client_items ALTER COLUMN client_id DROP NOT NULL;

ALTER TABLE marketing.client_items
  ADD COLUMN IF NOT EXISTS planned_date DATE,
  ADD COLUMN IF NOT EXISTS planned_time TIME,
  ADD COLUMN IF NOT EXISTS duration_min INTEGER,
  ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normaal',
  ADD COLUMN IF NOT EXISTS item_type TEXT NOT NULL DEFAULT 'taak',
  ADD COLUMN IF NOT EXISTS recur TEXT,
  ADD COLUMN IF NOT EXISTS recur_until DATE,
  ADD COLUMN IF NOT EXISTS series_id INTEGER,
  ADD COLUMN IF NOT EXISTS occ_date DATE,
  ADD COLUMN IF NOT EXISTS done_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS client_items_ws_planned_idx
  ON marketing.client_items (workspace_id, kind, planned_date);
CREATE INDEX IF NOT EXISTS client_items_series_idx
  ON marketing.client_items (series_id, occ_date);
