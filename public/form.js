<!doctype html>
<html lang="nl">
<head>
  <meta charset="utf-8" />
  <title>Dynamic CRM – Lead formulier</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: Arial, sans-serif; padding: 16px; background: #fafafa; }
    h1 { color: #333; text-align: center; }
    form { background: #fff; padding: 16px; border-radius: 8px; max-width: 520px; margin: 0 auto; box-shadow: 0 4px 20px rgba(0,0,0,.06); }
    label { display: block; margin: 12px 0 6px; font-weight: bold; }
    input, select, textarea { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 6px; }
    button { margin-top: 16px; padding: 10px 16px; border: 0; border-radius: 6px; background: #2563eb; color: #fff; cursor: pointer; }
    button:disabled { opacity: .6; cursor: not-allowed; }
    #msg { margin-top: 12px; font-weight: bold; text-align: center; }
    #msg.error { color: #b91c1c; }
    #msg.success { color: #15803d; }
  </style>
</head>
<body>
  <h1>Dynamic CRM — Nieuw lead</h1>

  <form id="leadForm" autocomplete="off">
    <label>Volledige naam</label>
    <input type="text" name="full_name" required placeholder="Bijv. Jan Jansen" />

    <label>Email</label>
    <input type="email" name="email" required placeholder="naam@voorbeeld.nl" />

    <label>Telefoon</label>
    <input type="tel" name="phone" placeholder="06… (optioneel)" />

    <label>Bron</label>
    <select name="source" required>
      <option value="Website" selected>Website</option>
      <option value="Instagram">Instagram</option>
      <option value="LinkedIn">LinkedIn</option>
      <option value="YouTube">YouTube</option>
      <option value="Referral">Doorverwijzing</option>
    </select>

    <label>Doel (optioneel)</label>
    <input type="text" name="doel" placeholder="Bijv. adviesgesprek" />

    <label style="display:flex; gap:8px; align-items:center; font-weight:normal;">
      <input type="checkbox" name="consent" checked />
      Ik geef toestemming om benaderd te worden
    </label>

    <button type="submit" id="submitBtn">Verstuur</button>
    <div id="msg"></div>
  </form>

  <script type="module">
    import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'

    // 🔧 Vul jouw Supabase gegevens in (jij gaf ze al):
    const SUPABASE_URL = 'https://ggutzcfkaumlnmmtmyrc.supabase.co';
    const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdndXR6Y2ZrYXVtbG5tbXRteXJjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTczMjgxODYsImV4cCI6MjA3MjkwNDE4Nn0.evnjtkIfviSERnY4bOE-SE5KQJiylpjcYvcSPtqTn1Y';

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    const form = document.getElementById('leadForm');
    const msg = document.getElementById('msg');
    const btn = document.getElementById('submitBtn');

    function showMessage(text, type='') {
      msg.textContent = text;
      msg.className = type;
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      showMessage('', '');
      btn.disabled = true;

      // 1) Lees velden
      const full_name = form.full_name.value.trim();
      const email     = form.email.value.trim();
      const phone     = form.phone.value.trim() || null;
      const source    = form.source.value;
      const consent   = form.consent.checked ? true : false;
      const doel      = form.doel.value.trim(); // optioneel

      // 2) Bouw payload, eerst mét 'doel'
      const payloadWithGoal = { full_name, email, phone, source, consent, doel };
      const payloadNoGoal   = { full_name, email, phone, source, consent };

      // 3) Probeer insert mét 'doel' (als kolom bestaat werkt het), anders fallback
      let inserted = false;
      let firstError = null;

      // Probeer mét doel
      let { data, error } = await supabase.from('leads').insert([payloadWithGoal]).select();
      if (error) {
        firstError = error;
        // Als fout zegt: kolom bestaat niet, nog een keer zonder 'doel'
        if (error.code === '42703' || (error.message && error.message.includes('column') && error.message.includes('does not exist'))) {
          const again = await supabase.from('leads').insert([payloadNoGoal]).select();
          if (!again.error) {
            inserted = true;
          } else {
            firstError = again.error;
          }
        }
      } else {
        inserted = true;
      }

      if (inserted) {
        showMessage('✔️ Lead succesvol opgeslagen — dankjewel!', 'success');
        form.reset();
      } else {
        console.error(firstError);
        showMessage('❌ Opslaan mislukt: ' + (firstError?.message || 'onbekende fout'), 'error');
      }

      btn.disabled = false;
    });
  </script>
</body>
</html>
