// public/form.js — fetch naar /leads + events naar /events + PRACTICE VALIDATION
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
    return normalizeCode(qs('s') || qs('praktijk') || qs('p') || '');
  }
  
  // ✅ FIX: Validate practice function
  async function validatePractice(practiceCode) {
    if (!practiceCode) {
      return { valid: false, message: 'Deze pagina is alleen toegankelijk via een unieke praktijklink.' };
    }
    
    try {
      const response = await fetch('/api/validate-practice?code=' + encodeURIComponent(practiceCode));
      const data = await response.json();
      
      if (!data.valid) {
        return { valid: false, message: 'Deze praktijk is momenteel niet actief. Neem contact op voor meer informatie.' };
      }
      
      return { valid: true, practice: data.practice };
    } catch (error) {
      console.error('Practice validation error:', error);
      return { valid: false, message: 'Kon praktijk niet valideren. Probeer het later opnieuw.' };
    }
  }
  
  // ✅ NEW: Load practice name dynamically from database
  async function loadPracticeName(practiceCode) {
    if (!practiceCode) return null;
    
    try {
      const response = await fetch(`/api/practice/${practiceCode}`);
      const data = await response.json();
      
      if (data.success && data.practice) {
        return data.practice;
      }
      return null;
    } catch (error) {
      console.error('Error loading practice name:', error);
      return null;
    }
  }
  
  function showBlockedMessage(message) {
    // Hide the form
    if (form) {
      form.style.display = 'none';
    }
    
    // Show error message
    const container = document.querySelector('.container');
    if (container) {
      const errorDiv = document.createElement('div');
      errorDiv.className = 'card';
      errorDiv.style.background = '#fee2e2';
      errorDiv.style.border = '2px solid #ef4444';
      errorDiv.style.padding = '30px 20px';
      errorDiv.style.textAlign = 'center';
      errorDiv.innerHTML = `
        <div style="font-size:64px;margin-bottom:16px">🚫</div>
        <h2 style="color:#991b1b;margin-bottom:12px;font-size:24px">Geen toegang</h2>
        <p style="color:#7f1d1d;font-size:15px;line-height:1.6">${message}</p>
      `;
      container.appendChild(errorDiv);
    }
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
  
  // ✅ FIX: Validate practice on page load BEFORE logging 'clicked' event
  (async function onLoad(){
    const code = normalizeCode(hidden.value || practiceFromUrl());
    
    // Validate practice
    const validation = await validatePractice(code);
    
    if (!validation.valid) {
      // Block the form
      showBlockedMessage(validation.message);
      return;
    }
    
    // ✅ NEW: Load and display practice name dynamically
    if (code) {
      const practice = await loadPracticeName(code);
      if (practice) {
        const badge = document.getElementById('practiceBadge');
        if (badge) {
          badge.style.display = 'inline-block';
          badge.textContent = practice.naam;
        }
        document.title = `Aanmelden - ${practice.naam}`;
        console.log('Practice loaded from database:', practice.naam);
      }
    }
    
    // Practice is valid - log 'clicked' event
    if (code) {
      postEvent({
        lead_id: null,
        practice_code: code,
        event_type: 'clicked',
        metadata: { path: location.pathname, ts: Date.now() }
      });
    }
  })();
  
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.textContent = '';
      msg.className = '';
      const code = normalizeCode(hidden.value || practiceFromUrl());
      
      // ✅ FIX: Validate practice before submitting
      const validation = await validatePractice(code);
      if (!validation.valid) {
        msg.textContent = validation.message;
        msg.className = 'error';
        return;
      }
      
      // ✅ NEW: Validate email and phone
      const email = form.emailadres.value.trim();
      const phone = form.telefoon.value.trim();
      
      if (!email || !email.includes('@') || !email.includes('.')) {
        msg.textContent = 'Voer een geldig email adres in';
        msg.className = 'error';
        form.emailadres.focus();
        return;
      }
      
      const phoneDigits = phone.replace(/\D/g, '');
      if (!phone || phoneDigits.length < 10) {
        msg.textContent = 'Voer een geldig telefoonnummer in (minimaal 10 cijfers)';
        msg.className = 'error';
        form.telefoon.focus();
        return;
      }
      
      const data = {
        volledige_naam: form.volledige_naam.value.trim(),
        emailadres:     email,
        telefoon:       phoneDigits,
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
        // Success! Show modal with practice name
        const leadId = json?.lead?.id ?? null;
        
        // Get practice name from validation result
        let practiceName = validation?.practice?.naam || 'de praktijk';
        
        // Trigger success modal (defined in form.html)
        if (typeof showSuccessModal === 'function') {
          showSuccessModal(practiceName);
        } else {
          // Fallback to old method if modal not available
          msg.textContent = 'Bedankt! Je aanmelding is verstuurd. We nemen snel contact op.';
          msg.className = 'success';
          // Note: form is NOT reset - data blijft staan
        }
        
        // Log event
        if (code) {
          postEvent({
            lead_id: leadId,
            practice_code: code,
            event_type: 'lead_submitted',
            metadata: { via: 'form.js', ts: Date.now() }
          });
        }
        
        // Keep hidden field populated
        hidden.value = code;
      }catch(err){
        msg.textContent = 'Kon niet opslaan: ' + err.message;
        msg.className = 'error';
      }
    });
  }
})();
