// dashboard.js - Verbeterde versie met praktijk codes uit URL

// Helpers
function $(id){ return document.getElementById(id); }
function fmt(n){ return (n??0).toLocaleString('nl-NL'); }
function pct(n){ return `${n??0}%`; }
function today(){ const d=new Date(); return d.toISOString().slice(0,10); }
function firstOfMonth(){
  const d = new Date(); d.setDate(1); return d.toISOString().slice(0,10);
}
function getParam(name, def=''){
  const v = new URLSearchParams(location.search).get(name);
  return v ? v : def;
}

let chart;

// Init UI
window.addEventListener('DOMContentLoaded', () => {
  // Check voor praktijk code in URL parameters (p of practice)
  const practiceCode = getParam('p', getParam('practice', ''));
  
  $('practice').value = practiceCode;
  $('from').value = getParam('from', firstOfMonth());
  $('to').value = getParam('to', today());
  
  // Event listeners
  $('btnLoad').addEventListener('click', loadAll);
  
  // Auto-load als er een practice code is
  if(practiceCode) {
    loadAll();
  }
  
  // Toon/verberg practice input afhankelijk van wie het bekijkt
  // Voor praktijken: verberg het input veld en toon alleen hun eigen data
  if(practiceCode && !isAdmin()) {
    const practiceInput = $('practice');
    if(practiceInput) {
      practiceInput.disabled = true;
      practiceInput.style.backgroundColor = '#f3f4f6';
    }
  }
});

// Check of het een admin is (optioneel)
function isAdmin() {
  // Je kunt hier checken op admin key in URL of cookie
  return getParam('admin') === '1' || window.location.pathname.includes('/admin');
}

async function loadAll(){
  const practice = $('practice').value.trim();
  const from = $('from').value;
  const to = $('to').value;
  
  if(!practice){ 
    alert('Geen praktijk code gevonden. Gebruik URL: dashboard.html?p=K9X3QY'); 
    return; 
  }
  
  // Toon loading state
  showLoading(true);
  
  try {
    const base = `/api/metrics?practice=${encodeURIComponent(practice)}&from=${from}&to=${to}`;
    const ser = `/api/series?practice=${encodeURIComponent(practice)}&from=${from}&to=${to}`;
    
    const [mRes, sRes] = await Promise.all([ fetch(base), fetch(ser) ]);
    
    if(!mRes.ok || !sRes.ok) {
      throw new Error('Failed to fetch data');
    }
    
    const metrics = await mRes.json();
    const series = await sRes.json();
    
    // Update praktijk naam indien aanwezig
    updatePracticeInfo(practice, metrics);
    
    // KPI tegels
    $('kpi-clicks').textContent = fmt(metrics.totals.clicked);
    $('kpi-leads').textContent = fmt(metrics.totals.lead_submitted);
    $('kpi-appts').textContent = fmt(metrics.totals.appointment_booked);
    $('kpi-reg').textContent = fmt(metrics.totals.registered);
    
    // Conversie percentages met kleur indicatie
    updateConversionRate('kpi-c2l', metrics.funnel.click_to_lead);
    updateConversionRate('kpi-l2a', metrics.funnel.lead_to_appt);
    updateConversionRate('kpi-a2r', metrics.funnel.appt_to_reg);
    updateConversionRate('kpi-c2r', metrics.funnel.click_to_reg);
    
    // Series naar datasets per type
    const byDay = {};
    for(const r of series.rows){
      const day = r.day; 
      const t = r.event_type; 
      const c = r.count;
      if(!byDay[day]) byDay[day] = {
        clicked:0,
        lead_submitted:0,
        appointment_booked:0,
        registered:0
      };
      byDay[day][t] = c;
    }
    
    const labels = Object.keys(byDay).sort();
    const clicked = labels.map(d => byDay[d].clicked);
    const leads = labels.map(d => byDay[d].lead_submitted);
    const appts = labels.map(d => byDay[d].appointment_booked);
    const regs = labels.map(d => byDay[d].registered);
    
    // Format dates voor betere leesbaarheid
    const formattedLabels = labels.map(d => {
      const date = new Date(d);
      return date.toLocaleDateString('nl-NL', { day: '2-digit', month: 'short' });
    });
    
    // Chart.js met betere kleuren
    const data = {
      labels: formattedLabels,
      datasets: [
        { 
          label:'Clicks', 
          data: clicked, 
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59, 130, 246, 0.1)',
          tension: .3 
        },
        { 
          label:'Leads', 
          data: leads, 
          borderColor: '#10b981',
          backgroundColor: 'rgba(16, 185, 129, 0.1)',
          tension: .3 
        },
        { 
          label:'Afspraken', 
          data: appts, 
          borderColor: '#f59e0b',
          backgroundColor: 'rgba(245, 158, 11, 0.1)',
          tension: .3 
        },
        { 
          label:'Registraties', 
          data: regs, 
          borderColor: '#ef4444',
          backgroundColor: 'rgba(239, 68, 68, 0.1)',
          tension: .3 
        },
      ]
    };
    
    const opts = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { 
          labels: { color:'#e5e7eb' },
          position: 'bottom'
        },
        tooltip: { 
          mode: 'index', 
          intersect: false,
          backgroundColor: 'rgba(17, 24, 39, 0.9)',
          titleColor: '#f3f4f6',
          bodyColor: '#e5e7eb',
          borderColor: '#374151',
          borderWidth: 1
        }
      },
      scales: {
        x: { 
          ticks: { color:'#9ca3af' }, 
          grid:{ color:'#1f2937' } 
        },
        y: { 
          ticks: { color:'#9ca3af' }, 
          grid:{ color:'#1f2937' }, 
          beginAtZero:true, 
          precision:0 
        }
      }
    };
    
    const ctx = document.getElementById('seriesChart').getContext('2d');
    if(chart) chart.destroy();
    chart = new Chart(ctx, { type:'line', data, options:opts });
    
  } catch(error) {
    console.error('Error loading data:', error);
    alert('Fout bij het laden van data. Controleer de praktijk code.');
  } finally {
    showLoading(false);
  }
}

// Update conversie percentage met kleur
function updateConversionRate(elementId, value) {
  const el = $(elementId);
  if(!el) return;
  
  el.textContent = pct(value);
  
  // Voeg kleur toe op basis van percentage
  if(value >= 75) {
    el.style.color = '#10b981'; // Groen
  } else if(value >= 50) {
    el.style.color = '#f59e0b'; // Oranje
  } else if(value >= 25) {
    el.style.color = '#f97316'; // Donker oranje
  } else {
    el.style.color = '#ef4444'; // Rood
  }
}

// Update praktijk info
function updatePracticeInfo(code, metrics) {
  const titleEl = document.querySelector('h1');
  if(titleEl && !titleEl.dataset.original) {
    titleEl.dataset.original = titleEl.textContent;
    titleEl.textContent = `Dashboard - Praktijk ${code}`;
  }
}

// Loading state
function showLoading(show) {
  const loader = $('loader');
  if(loader) {
    loader.style.display = show ? 'block' : 'none';
  }
  
  // Disable/enable button
  const btn = $('btnLoad');
  if(btn) {
    btn.disabled = show;
    btn.textContent = show ? 'Laden...' : 'Laad data';
  }
}

// Export functie voor CSV download
window.exportData = async function() {
  const practice = $('practice').value.trim();
  const from = $('from').value;
  const to = $('to').value;
  
  if(!practice) {
    alert('Geen praktijk code gevonden');
    return;
  }
  
  const url = `/api/export-leads?practice=${practice}&from=${from}&to=${to}`;
  window.location.href = url;
}