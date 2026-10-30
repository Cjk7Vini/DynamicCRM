-- Migratie 026: organische KPI-normen per werkplek. Een bureau stelt hier in welke
-- organische KPI's de AI-analyse meeneemt en bij welke waarden die goed, gemiddeld of
-- zwak zijn. Geldt voor alle klanten van de werkplek. Leeg = standaardwaarden.
-- Draai eenmalig in Neon.
ALTER TABLE marketing.workspaces
  ADD COLUMN IF NOT EXISTS organic_kpis JSONB;
