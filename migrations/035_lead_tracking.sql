-- 035: leads meetbaar maken tegenover Meta.
-- 1) Per lead bewaren waarmee hij aan Meta te koppelen is: het event-ID dat naar Meta
--    ging, het klik-ID van de advertentie (fbclid) en de UTM-tags van de link.
-- 2) Bij het verwijderen van een lead een spoor bewaren ZONDER persoonsgegevens
--    (geen naam, e-mail of telefoon): welke lead, van welke praktijk, wanneer
--    binnengekomen, wanneer en door wie verwijderd. Zo is een verschil met Meta
--    achteraf te verklaren.
-- Bestaande data wordt niet aangeraakt: de nieuwe kolommen beginnen leeg.

ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS meta_event_id TEXT;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS fbclid TEXT;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS utm_source TEXT;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS utm_medium TEXT;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS utm_campaign TEXT;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS landing_url TEXT;

CREATE TABLE IF NOT EXISTS public.leads_verwijderd (
  id              BIGSERIAL PRIMARY KEY,
  lead_id         BIGINT,
  praktijk_code   TEXT,
  aangemaakt_op   TIMESTAMPTZ,
  bron            TEXT,
  funnel_stage    TEXT,
  meta_event_id   TEXT,
  fbclid          TEXT,
  utm_campaign    TEXT,
  verwijderd_op   TIMESTAMPTZ NOT NULL DEFAULT now(),
  verwijderd_door TEXT
);
CREATE INDEX IF NOT EXISTS leads_verwijderd_praktijk_idx ON public.leads_verwijderd (praktijk_code, aangemaakt_op);

-- Terugdraaien (alleen als het echt nodig is):
-- DROP TABLE IF EXISTS public.leads_verwijderd;
-- ALTER TABLE public.leads DROP COLUMN IF EXISTS meta_event_id, DROP COLUMN IF EXISTS fbclid,
--   DROP COLUMN IF EXISTS utm_source, DROP COLUMN IF EXISTS utm_medium,
--   DROP COLUMN IF EXISTS utm_campaign, DROP COLUMN IF EXISTS landing_url;
