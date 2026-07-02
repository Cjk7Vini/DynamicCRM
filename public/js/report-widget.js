/**
 * report-widget.js, gedeelde "Iets melden"-widget (ticketsysteem).
 * Insluiten met: <script src="/js/report-widget.js"></script>
 * Toont een knop + modal (lay-out B). Alleen zichtbaar voor ingelogde gebruikers.
 */
(function () {
  'use strict';

  function omgevingVanPagina() {
    var p = (location.pathname || '').toLowerCase();
    if (p.indexOf('churn-dashboard') > -1) return 'dashboard';
    if (p.indexOf('nazorg') > -1) return 'nazorg';
    if (p.indexOf('calculator') > -1) return 'calculator';
    if (p.indexOf('portaal') > -1) return 'portaal';
    return 'overig';
  }

  var CATS_BASIS = ['Dashboard', 'Licentie', 'Portaal', 'Calculator', 'Nazorgportaal', 'Anders'];
  function categorieenVoor(type) {
    if (type === 'incident') return ['Dashboard', 'Licentie', 'Bug', 'Portaal', 'Calculator', 'Nazorgportaal', 'Anders'];
    return CATS_BASIS;
  }

  function injectStyles() {
    if (document.getElementById('rw-style')) return;
    var css = ''
      + '#rw-btn{position:fixed;right:20px;bottom:20px;z-index:99998;background:#333399;color:#fff;border:none;border-radius:999px;padding:11px 18px;font-size:14px;font-weight:600;font-family:inherit;cursor:pointer;box-shadow:0 6px 20px rgba(51,51,153,.35);}'
      + '#rw-btn:hover{filter:brightness(1.08);}'
      + '#rw-overlay{position:fixed;inset:0;z-index:99999;background:rgba(20,20,40,.45);display:none;align-items:center;justify-content:center;padding:20px;}'
      + '#rw-overlay.open{display:flex;}'
      + '.rw-modal{width:100%;max-width:560px;background:#fff;border-radius:16px;box-shadow:0 20px 60px rgba(20,20,40,.3);overflow:hidden;font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;color:#1A1D21;max-height:92vh;overflow-y:auto;}'
      + '.rw-head{background:#1A1D21;color:#fff;padding:20px 26px;display:flex;justify-content:space-between;align-items:center;}'
      + '.rw-head h2{font-size:18px;margin:0;}.rw-head .rw-sub{font-size:12px;color:#b9bcc4;margin-top:2px;}'
      + '.rw-x{background:none;border:none;color:#fff;font-size:22px;cursor:pointer;line-height:1;}'
      + '.rw-body{padding:22px 26px 26px;}'
      + '.rw-lab{font-size:12px;font-weight:700;color:#374151;margin:0 0 9px;text-transform:uppercase;letter-spacing:.4px;}'
      + '.rw-field{margin-bottom:20px;}'
      + '.rw-tiles{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;}'
      + '.rw-tile{border:1.5px solid #e6e8ee;border-radius:12px;padding:12px;cursor:pointer;background:#fff;text-align:left;font-family:inherit;}'
      + '.rw-tile .tt{font-size:14px;font-weight:700;color:#1A1D21;}.rw-tile .td{font-size:11px;color:#9aa0aa;margin-top:3px;}'
      + '.rw-tile.on{border-color:#333399;background:#f5f5ff;}'
      + '.rw-field select,.rw-field textarea{width:100%;box-sizing:border-box;padding:11px 12px;border:1.5px solid #e6e8ee;border-radius:11px;font-size:14px;font-family:inherit;background:#fff;color:#1A1D21;}'
      + '.rw-field textarea{min-height:100px;resize:vertical;}'
      + '.rw-prio{background:#fff7ed;border:1px solid #fed7aa;border-radius:12px;padding:14px;}'
      + '.rw-prio .rw-lab{color:#c2410c;}'
      + '.rw-submit{width:100%;background:#333399;color:#fff;border:none;border-radius:12px;padding:14px;font-size:15px;font-weight:700;cursor:pointer;}'
      + '.rw-submit:disabled{opacity:.6;cursor:not-allowed;}'
      + '.rw-foot{font-size:12px;color:#9aa0aa;text-align:center;margin-top:14px;}'
      + '.rw-msg{font-size:13px;margin-top:12px;text-align:center;}.rw-msg.err{color:#dc2626;}.rw-msg.ok{color:#16a34a;}';
    var s = document.createElement('style');
    s.id = 'rw-style';
    s.textContent = css;
    document.head.appendChild(s);
  }

  var currentType = 'incident';

  function renderCategorieOpties() {
    var sel = document.getElementById('rw-categorie');
    if (!sel) return;
    sel.innerHTML = categorieenVoor(currentType).map(function (c) { return '<option>' + c + '</option>'; }).join('');
  }

  function setType(t) {
    currentType = t;
    var tiles = document.querySelectorAll('#rw-tiles .rw-tile');
    tiles.forEach(function (el) { el.classList.toggle('on', el.getAttribute('data-type') === t); });
    document.getElementById('rw-prio-field').style.display = (t === 'incident') ? '' : 'none';
    renderCategorieOpties();
  }

  function buildModal() {
    if (document.getElementById('rw-overlay')) return;
    var ov = document.createElement('div');
    ov.id = 'rw-overlay';
    ov.innerHTML =
      '<div class="rw-modal" role="dialog" aria-modal="true">' +
        '<div class="rw-head"><div><h2>Iets melden</h2><div class="rw-sub">Dynamic Health Consultancy, support</div></div><button class="rw-x" id="rw-close">&times;</button></div>' +
        '<div class="rw-body">' +
          '<div class="rw-field"><div class="rw-lab">Type melding</div><div class="rw-tiles" id="rw-tiles">' +
            '<button class="rw-tile on" data-type="incident"><div class="tt">Incident</div><div class="td">Er gaat iets fout</div></button>' +
            '<button class="rw-tile" data-type="wens"><div class="tt">Wens</div><div class="td">Verbetering of idee</div></button>' +
            '<button class="rw-tile" data-type="andere_vraag"><div class="tt">Andere vraag</div><div class="td">Algemene vraag</div></button>' +
          '</div></div>' +
          '<div class="rw-field"><div class="rw-lab">Categorie</div><select id="rw-categorie"></select></div>' +
          '<div class="rw-field rw-prio" id="rw-prio-field"><div class="rw-lab">Prioriteit (alleen bij incident)</div>' +
            '<select id="rw-prioriteit"><option value="P1">P1 (Hoogste prioriteit)</option><option value="P2">P2 (Hoge prioriteit)</option><option value="P3" selected>P3 (Normaal)</option><option value="P4">P4 (Laag)</option></select></div>' +
          '<div class="rw-field"><div class="rw-lab">Bericht</div><textarea id="rw-bericht" placeholder="Omschrijf het zo duidelijk mogelijk..."></textarea></div>' +
          '<button class="rw-submit" id="rw-submit">Melding versturen</button>' +
          '<div class="rw-msg" id="rw-status"></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);

    ov.addEventListener('click', function (e) { if (e.target === ov) closeModal(); });
    document.getElementById('rw-close').addEventListener('click', closeModal);
    document.querySelectorAll('#rw-tiles .rw-tile').forEach(function (el) {
      el.addEventListener('click', function () { setType(el.getAttribute('data-type')); });
    });
    document.getElementById('rw-submit').addEventListener('click', verstuur);
    setType('incident');
  }

  function openModal() {
    buildModal();
    document.getElementById('rw-status').textContent = '';
    document.getElementById('rw-bericht').value = '';
    setType('incident');
    document.getElementById('rw-overlay').classList.add('open');
  }
  function closeModal() {
    var ov = document.getElementById('rw-overlay');
    if (ov) ov.classList.remove('open');
  }

  function verstuur() {
    var btn = document.getElementById('rw-submit');
    var statusEl = document.getElementById('rw-status');
    var bericht = (document.getElementById('rw-bericht').value || '').trim();
    if (!bericht) { statusEl.className = 'rw-msg err'; statusEl.textContent = 'Vul een bericht in.'; return; }
    var payload = {
      type: currentType,
      categorie: document.getElementById('rw-categorie').value,
      prioriteit: currentType === 'incident' ? document.getElementById('rw-prioriteit').value : null,
      bericht: bericht,
      omgeving: omgevingVanPagina()
    };
    btn.disabled = true; statusEl.className = 'rw-msg'; statusEl.textContent = 'Versturen...';
    fetch('/api/tickets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(payload) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (res.ok && res.d.success) {
          statusEl.className = 'rw-msg ok';
          statusEl.textContent = 'Bedankt! Je melding (#' + res.d.id + ') is verstuurd.';
          setTimeout(closeModal, 1600);
        } else {
          statusEl.className = 'rw-msg err';
          statusEl.textContent = (res.d && res.d.error) ? res.d.error : 'Er ging iets mis. Probeer opnieuw.';
        }
      })
      .catch(function () { statusEl.className = 'rw-msg err'; statusEl.textContent = 'Netwerkfout. Probeer opnieuw.'; })
      .finally(function () { btn.disabled = false; });
  }

  function init() {
    // Modal-styling en de open-functie meteen beschikbaar maken, zodat
    // menu-items (openReportModal) altijd werken, ook vóór de auth-check.
    injectStyles();
    window.openReportModal = openModal;

    // De zwevende knop alleen tonen voor ingelogde gebruikers.
    fetch('/api/auth/me', { credentials: 'include' })
      .then(function (r) { if (!r.ok) throw new Error('niet ingelogd'); return r.json(); })
      .then(function () {
        if (document.getElementById('rw-btn')) return;
        var btn = document.createElement('button');
        btn.id = 'rw-btn';
        btn.type = 'button';
        btn.textContent = 'Iets melden';
        btn.addEventListener('click', openModal);
        document.body.appendChild(btn);
      })
      .catch(function () { /* niet ingelogd: geen zwevende knop */ });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
