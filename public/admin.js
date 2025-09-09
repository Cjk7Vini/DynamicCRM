<!doctype html>
<html lang="nl">
<head>
  <meta charset="utf-8" />
  <title>Dynamic CRM – Leads (Admin)</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: Arial, sans-serif; padding: 16px; background: #fafafa; }
    h1 { color: #333; }
    .controls { margin: 12px 0; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    input { padding: 8px; border: 1px solid #ddd; border-radius: 6px; }
    button { padding: 8px 14px; border: 0; border-radius: 6px; background: #2563eb; color: #fff; cursor: pointer; }
    #msg { margin: 8px 0; font-weight: bold; }
    #msg.error { color: #b91c1c; }
    #msg.success { color: #15803d; }
    table { border-collapse: collapse; width: 100%; background: #fff; border-radius: 8px; overflow: hidden; }
    th, td { border: 1px solid #eee; padding: 8px; text-align: left; }
    th { background: #f1f5f9; }
    .password-wrapper { display:inline-flex; align-items:center; gap:6px; }
  </style>
</head>
<body>
  <h1>Dynamic CRM — Admin</h1>

  <div class="controls">
    <label>Admin sleutel:</label>
    <span class="password-wrapper">
      <input id="key" type="password" placeholder="voer ADMIN_KEY in" style="width:260px" />
      <button type="button" id="toggle">👁️</button>
    </span>
    <button id="load">Laad leads</button>
    <button id="autofill">Vul sleutel uit URL (?key=…)</button>
  </div>

  <div id="msg"></div>

  <table id="tbl">
    <thead><tr id="thead"></tr></thead>
    <tbody id="tbody"></tbody>
  </table>

  <script type="module">
    import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'

    // 🔧 Supabase gegevens:
    const SUPABASE_URL = 'https://ggutzcfkaumlnmmtmyrc.supabase.co';
    const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdndXR6Y2ZrYXVtbG5tbXRteXJjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTczMjgxODYsImV4cCI6MjA3MjkwNDE4Nn0.evnjtkIfviSERnY4bOE-SE5KQJiylpjcYvcSPtqTn1Y';

    // ⚠️ Simpele client-side “admin key” (voor nu prima, niet super-veilig):
    const ADMIN_KEY_EXPECTED = 'ZwaarGeheim321!!';

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    const msg = document.getElementById('msg');
    const thead = document.getElementById('thead');
    const tbody = document.getElementById('tbody');

    function showMsg(text, type='') {
      msg.textContent = text;
      msg.className = type;
    }

    // Wachtwoord tonen/verbergen
    document.getElementById('toggle').addEventListener('click', () => {
      const inp = document.getElementById('key');
      inp.type = (inp.type === 'password') ? 'text' : 'password';
    });

    // Sleutel uit URL halen (?key=…)
    document.getElementById('autofill').addEventListener('click', () => {
      const params = new URLSearchParams(location.search);
      const k = params.get('key');
      if (k) {
        document.getElementById('key').value = k;
        showMsg('Sleutel uit URL ingevuld.', 'success');
      } else {
        showMsg('Geen sleutel in URL gevonden.', 'error');
      }
    });

    // Tabel tekenaar
    function renderTable(rows) {
      thead.innerHTML = '';
      tbody.innerHTML = '';

      if (!rows || rows.length === 0) {
        thead.innerHTML = '<th>Geen resultaten</th>';
        return;
      }

      const cols = Object.keys(rows[0]);
      cols.forEach(c => {
        const th = document.createElement('th');
        th.textContent = c;
        thead.appendChild(th);
      });

      rows.forEach(r => {
        const tr = document.createElement('tr');
        cols.forEach(c => {
          const td = document.createElement('td');
          td.textContent = r[c] ?? '';
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
    }

    // Ophalen met fallback (ENG kolommen → NL kolommen)
    async function fetchLeadsSmart() {
      // Eerst proberen met standaard ENG kolommen:
      let q1 = await supabase
        .from('leads')
        .select('id, full_name, email, phone, source, consent, doel, created_at')
        .order('created_at', { ascending: false })
        .limit(500);

      if (!q1.error) return q1.data;

      // Als fout: probeer NL kolommen en map naar ENG labels:
      let q2 = await supabase
        .from('leads')
        .select('id, volledige_naam, email, telefoon, bron, toestemming, doel, aangemaakt_op')
        .order('aangemaakt_op', { ascending: false })
        .limit(500);

      if (!q2.error) {
        return (q2.data || []).map(r => ({
          id: r.id,
          full_name: r.volledige_naam,
          email: r.email,
          phone: r.telefoon,
          source: r.bron,
          consent: r.toestemming,
          doel: r.doel,
          created_at: r.aangemaakt_op
        }));
      }

      // Beide mislukt
      throw new Error(q1.error?.message || q2.error?.message || 'Onbekende DB-fout');
    }

    // Klik: leads laden
    document.getElementById('load').addEventListener('click', async () => {
      showMsg('', '');
      const key = document.getElementById('key').value.trim();
      if (!key) return showMsg('Vul eerst de admin sleutel in.', 'error');
      if (key !== ADMIN_KEY_EXPECTED) return showMsg('Ongeldige admin sleutel.', 'error');

      try {
        showMsg('Laden…');
        const rows = await fetchLeadsSmart();
        renderTable(rows);
        showMsg(`Leads geladen (${rows.length}).`, 'success');
      } catch (e) {
        console.error(e);
        showMsg('Database error: ' + e.message, 'error');
      }
    });

    // Auto-load als ?key= in URL staat
    window.addEventListener('load', () => {
      const params = new URLSearchParams(location.search);
      const k = params.get('key');
      if (k) {
        document.getElementById('key').value = k;
        document.getElementById('load').click();
      }
    });
  </script>
</body>
</html>
