-- Afspraaktype per lead (Intake/Check-up of Rondleiding).
-- Voer dit eenmalig uit in Neon. De code werkt ook zonder deze kolom
-- (dan valt de weergave terug op 'vitaliteitscheck' zoals voorheen), maar
-- met de kolom wordt het gekozen type correct opgeslagen en getoond in het
-- dashboard i.p.v. altijd 'Intake/Check-up'.

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS appointment_type text;
