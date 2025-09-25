// Simplified dashboard focusing on conversion

function $(id) { 
  return document.getElementById(id); 
}

function show(id) { 
  $(id).style.display = 'block'; 
}

function hide(id) { 
  $(id).style.display = 'none'; 
}

function today() { 
  return new Date().toISOString().slice(0, 10); 
}

function firstOfMonth() {
  const d = new Date();
  d.setDate(1);
  return d.toISOString().slice(0, 10);
}

function getParam(name, def = '') {
  const v = new URLSearchParams(location.search).get(name);
  return v || def;
}

let conversionChart = null;

window.addEventListener('DOMContentLoaded', () => {
  const practiceCode = getParam('p', getParam('practice', ''));
  
  $('practice').value = practiceCode;
  $('from').value = getParam('from', firstOfMonth());
  $('to').value = getParam('to', today());
  
  $('btnLoad').addEventListener('click', loadDashboard);
  
  if (practiceCode) {
    loadDashboard();
  }
});

async function loadDashboard() {
  const practice = $('practice').value.trim();
  const from = $('from').value;
  const to = $('to').value;
  
  if (!practice) {
    alert('Vul een praktijk code in (bijv. K9X3QY)');
    return;
  }
  
  hide('content');
  show('loading');
  $('btnLoad').disabled = true;
  $('btnLoad').textContent = 'Laden...';
  
  try {
    const [metricsRes, seriesRes] = await Promise.all([
      fetch(`/api/metrics?practice=${encodeURIComponent(practice)}&from=${from}&to=${to}`),
      fetch(`/api/series?practice=${encodeURIComponent(practice)}&from=${from}&to=${to}`)
    ]);
    
    if (!metricsRes.ok || !seriesRes.ok) {
      throw new Error('Kon data niet ophalen');
    }
    
    const metrics = await metricsRes.json();
    const series = await seriesRes.json();
    
    updateStatistics(metrics);
    updateChart(series);
    
    hide('loading');
    show('content');
    
  } catch (error) {
    console.error('Error:', error);
    hide('loading');
    alert('Er ging iets mis bij het laden van de data.');
  } finally {
    $('btnLoad').disabled = false;
    $('btnLoad').textContent = 'Laden';
  }
}

function updateStatistics(metrics) {
  const totals = metrics.totals || {};
  
  $('total-leads').textContent = totals.lead_submitted || 0;
  $('total-appointments').textContent = totals.appointment_booked || 0;
  $('total-members').textContent = totals.registered || 0;
  
  const conversionRate = totals.lead_submitted > 0 
    ? Math.round((totals.registered / totals.lead_submitted) * 100)
    : 0;
  
  const conversionEl = $('conversion-rate');
  conversionEl.textContent = conversionRate + '%';
  
  if (conversionRate >= 50) {
    conversionEl.className = 'stat-value success';
  } else if (conversionRate >= 25) {
    conversionEl.className = 'stat-value warning';
  } else {
    conversionEl.className = 'stat-value danger';
  }
}

function updateChart(series) {
  const byDay = {};
  
  series.rows.forEach(row => {
    const day = row.day;
    if (!byDay[day]) {
      byDay[day] = {
        clicked: 0,
        lead_submitted: 0,
        appointment_booked: 0,
        registered: 0
      };
    }
    byDay[day][row.event_type] = row.count;
  });
  
  const days = Object.keys(byDay).sort();
  
  const labels = days.map(d => {
    const date = new Date(d + 'T12:00:00');
    return date.toLocaleDateString('nl-NL', { 
      day: 'numeric', 
      month: 'short' 
    });
  });
  
  const leads = days.map(d => byDay[d].lead_submitted);
  const appointments = days.map(d => byDay[d].appointment_booked);
  const members = days.map(d => byDay[d].registered);
  
  const chartData = {
    labels: labels,
    datasets: [
      {
        label: 'Leads',
        data: leads,
        backgroundColor: 'rgba(59, 130, 246, 0.6)',
        type: 'bar'
      },
      {
        label: 'Afspraken',
        data: appointments,
        backgroundColor: 'rgba(245, 158, 11, 0.6)',
        type: 'bar'
      },
      {
        label: 'Leden',
        data: members,
        backgroundColor: 'rgba(16, 185, 129, 0.6)',
        type: 'bar'
      }
    ]
  };
  
  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: true,
        position: 'bottom',
        labels: {
          color: '#e5e7eb'
        }
      }
    },
    scales: {
      x: {
        grid: {
          color: 'rgba(31, 41, 55, 0.5)'
        },
        ticks: {
          color: '#9ca3af'
        }
      },
      y: {
        grid: {
          color: 'rgba(31, 41, 55, 0.5)'
        },
        ticks: {
          color: '#9ca3af'
        }
      }
    }
  };
  
  if (conversionChart) {
    conversionChart.destroy();
  }
  
  const ctx = $('conversionChart').getContext('2d');
  conversionChart = new Chart(ctx, {
    type: 'bar',
    data: chartData,
    options: chartOptions
  });
}