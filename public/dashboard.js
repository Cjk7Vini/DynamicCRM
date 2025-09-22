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
  $('practice').value = getParam('practice', '');
  $('from').value = getParam('from', firstOfMonth());
  $('to').value = getParam('to', today());
  $('btnLoad').addEventListener('click', loadAll);
  loadAll(); // auto
});

async function loadAll(){
  const practice = $('practice').value.trim();
  const from = $('from').value;
  const to = $('to').value;
  if(!practice){ alert('Vul een praktijk code in, bijv. PRAK001'); return; }

  const base = `/api/metrics?practice=${encodeURIComponent(practice)}&from=${from}&to=${to}`;
  const ser = `/api/series?practice=${encodeURIComponent(practice)}&from=${from}&to=${to}`;

  const [mRes, sRes] = await Promise.all([ fetch(base), fetch(ser) ]);
  const metrics = await mRes.json();
  const series = await sRes.json();

  // KPI tegels
  $('kpi-clicks').textContent = fmt(metrics.totals.clicked);
  $('kpi-leads').textContent = fmt(metrics.totals.lead_submitted);
  $('kpi-appts').textContent = fmt(metrics.totals.appointment_booked);
  $('kpi-reg').textContent = fmt(metrics.totals.registered);

  $('kpi-c2l').textContent = pct(metrics.funnel.click_to_lead);
  $('kpi-l2a').textContent = pct(metrics.funnel.lead_to_appt);
  $('kpi-a2r').textContent = pct(metrics.funnel.appt_to_reg);
  $('kpi-c2r').textContent = pct(metrics.funnel.click_to_reg);

  // Series naar datasets per type
  const byDay = {};
  for(const r of series.rows){
    const day = r.day; const t = r.event_type; const c = r.count;
    if(!byDay[day]) byDay[day] = {clicked:0,lead_submitted:0,appointment_booked:0,registered:0};
    byDay[day][t] = c;
  }
  const labels = Object.keys(byDay).sort();
  const clicked = labels.map(d => byDay[d].clicked);
  const leads = labels.map(d => byDay[d].lead_submitted);
  const appts = labels.map(d => byDay[d].appointment_booked);
  const regs = labels.map(d => byDay[d].registered);

  // Chart.js
  const data = {
    labels,
    datasets: [
      { label:'Clicked', data: clicked, tension: .3 },
      { label:'Leads', data: leads, tension: .3 },
      { label:'Appointments', data: appts, tension: .3 },
      { label:'Registered', data: regs, tension: .3 },
    ]
  };
  const opts = {
    responsive: true,
    plugins: {
      legend: { labels: { color:'#e5e7eb' } },
      tooltip: { mode: 'index', intersect: false }
    },
    scales: {
      x: { ticks: { color:'#9ca3af' }, grid:{ color:'#1f2937' } },
      y: { ticks: { color:'#9ca3af' }, grid:{ color:'#1f2937' }, beginAtZero:true, precision:0 }
    }
  };
  const ctx = document.getElementById('seriesChart').getContext('2d');
  if(chart) chart.destroy();
  chart = new Chart(ctx, { type:'line', data, options:opts });
}
