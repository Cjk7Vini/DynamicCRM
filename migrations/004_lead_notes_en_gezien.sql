-- Leadbeheer: notities-tijdlijn per lead + "gezien"-indicator voor nieuwe leads.
-- Voer dit eenmalig uit in Neon. De code werkt ook zonder deze objecten
-- (dan zijn er simpelweg geen notities en geen gezien-badge), maar met de
-- migratie werkt het volledige leadscherm.

-- Notities per lead (meerdere, met auteur en tijdstip).
CREATE TABLE IF NOT EXISTS public.lead_notes (
  id BIGSERIAL PRIMARY KEY,
  lead_id BIGINT NOT NULL,
  praktijk_code TEXT NOT NULL,
  auteur TEXT,
  tekst TEXT NOT NULL,
  aangemaakt_op TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lead_notes_lead ON public.lead_notes(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_notes_praktijk ON public.lead_notes(praktijk_code);

-- Gezien-indicator: NULL = nog niet bekeken door een collega (nieuw/walk-in).
-- Wordt gezet zodra iemand het leadprofiel opent.
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS gezien_op TIMESTAMPTZ;
