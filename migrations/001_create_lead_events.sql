-- Maak tabel met alle stappen in de funnel
CREATE TABLE IF NOT EXISTS lead_events (
  id BIGSERIAL PRIMARY KEY,
  lead_id BIGINT NOT NULL,
  practice_code TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('clicked','lead_submitted','appointment_booked','registered')),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor TEXT DEFAULT 'system',
  metadata JSONB DEFAULT '{}'::jsonb
);

-- Snellere zoekopdrachten
CREATE INDEX IF NOT EXISTS idx_lead_events_lead ON lead_events(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_events_practice ON lead_events(practice_code);
CREATE INDEX IF NOT EXISTS idx_lead_events_type_time ON lead_events(event_type, occurred_at);

-- (optioneel) als leads.id geen BIGINT is, pas BIGINT aan naar het juiste type.
