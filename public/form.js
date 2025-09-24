// public/form.js — fetch naar /leads + events naar /events

(function(){
  const form   = document.getElementById('leadForm');
  const msg    = document.getElementById('msg');
  const hidden = document.getElementById('praktijk_code');

  function normalizeCode(raw){
    if(!raw) return '';
    return String(raw).trim().replace(/[^A-Za-z0-9_-]/g,'');
  }
  function qs(name){
    try { return new URLSearchParams(location.search).get(name) || ''; }
    catch(_) { return ''; }
  }
  function practiceFromUrl(){
    return normalizeCode(qs('s') || qs('praktijk') || '');
  }

  // Melding bij ?ok=1 (fallback post)
  (function showOk(){
    try{
      const p=new URLSearchParams(location.search);
      if(p.get('ok')==='1'){
        msg.textContent='Bedankt! Je aanmelding is verstuurd. We nemen snel contact op.';
        msg.className='success';
      }
    }catch(_){}
  })();

  // Hidden praktijk_code vanuit URL
  (function setPraktijkCodeFromUrl(){
    const code = practiceFromUrl();
    if(code) hidden.value = code;
  })();

  async function postEvent(payload){
    try{
      if (navigator.sendBeacon) {
        const blob = new Blob([JSON.stringify(payload)], {type:'application/json'});
        navigator.sendBeacon('/events', blob);
        return;
      }
      await fetch('/events', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify(payload)
      });
    }catch(_){}
  }

  // Log 'clicked' bij openen (alleen als code bekend is)
  (function onOpen(){
    const code = normalizeCode(hidden.value || practiceFromUrl());
    if (!code) return;
    postEvent({
      lead_id: null,
      practice_code: code,
      event_type: 'clicked',
      metadata: { path: location.pathname, ts: Date.now() }
    });
  })();

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.textContent = '';
      msg.className = '';

      const code = normalizeCode(hidden.value || practiceFromUrl());

      const data = {
        volledige_naam: form.volledige_naam.value.trim(),
        emailadres:     form.emailadres.value.trim() || null,
        telefoon:       form.telefoon.value.trim() || null,
        bron:           form.bron.value || null,
        doel:           form.doel.value.trim() || null,
        toestemming:    form.toestemming.checked,
        praktijk_code:  code || null
      };

      try{
        const res  = await fetch('/leads', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify(data)
        });
        const json = await res.json().catch(()=>({}));

        if(!res.ok){
          msg.textContent = 'Fout: ' + (json.error || res.statusText);
          msg.className = 'error';
          console.error('Server detail:', json.details);
          return;
        }

        msg.textContent = 'Bedankt! Je aanmelding is verstuurd. We nemen snel contact op.';
        msg.className = 'success';

        const leadId = json?.lead?.id ?? null;
        if (code) {
          postEvent({
            lead_id: leadId,
            practice_code: code,
            event_type: 'lead_submitted',
            metadata: { via: 'form.js', ts: Date.now() }
          });
        }

        form.reset();
        hidden.value = code;
      }catch(err){
        msg.textContent = 'Kon niet opslaan: ' + err.message;
        msg.className = 'error';
      }
    });
  }
})();
