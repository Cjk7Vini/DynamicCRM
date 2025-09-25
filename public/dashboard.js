// dashboard.js - Simplified version focusing on conversion

// Helpers
function $(id) { return document.getElementById(id); }
function show(id) { $(id).style.display = 'block'; }
function hide(id) { $(id).style.display = 'none'; }

// Date helpers
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

// Global chart variable
let conversionChart = null;

// Initialize on page load
window.addEventListener('DOMContentLoaded', () => {
  // Set initial values from URL or defaults
  const practiceCode = getParam('p', getParam('practice', ''));
  
  $('practice').value = practiceCode;
  $('from').value = getParam('from', firstOfMonth());
  $('to').value = getParam('to', today());
  
  // Add event listener to load button
  $('btnLoad').addEventListener('click', loadDashboard);
  
  // Auto-load if practice code is in URL
  if (practiceCode) {
    loadDashboard();
  }
});

// Main load function
async function loadDashboard() {
  const practice = $('practice').value.trim();
  const from = $('from').value;
  const to = $('to').value;
  
  if (!practice) {
    alert('Vul een praktijk code in (bijv. K9X3QY)');
    return;
  }
  
  // Show loading state
  hide('content');
  show('loading');
  $('btnLoad').disabled = true;
  $('btnLoad').textContent = 'Laden...';
  
  try {
    // Fetch data
    const [metricsRes, seriesRes] = await Promise.all([
      fetch(`/api/metrics?practice=${encodeURIComponent(practice)}&from=${from}&to=${to}`),
      fetch(`/api/series?practice=${encodeURIComponent(practice)}&from=${from}&to=${to}`)
    ]);
    
    if (!metricsRes.ok || !seriesRes.ok) {
      throw new Error('Kon data niet ophalen');
    }
    
    const metrics = await metricsRes.json();
    const series = await seriesRes.json();
    
    // Update statistics
    updateStatistics(metrics);
    
    // Update funnel
    updateFunnel(metrics);
    
    // Update chart
    updateChart(series);
    
    // Show content
    hide('loading');
    show('content');
    
  } catch (error) {
    console.error('Error:', error);
    hide('loading');
    alert('Er ging iets mis bij het laden van de data. Controleer de praktijk code.');
  } finally {
    $('btnLoad').disabled = false;
    $('btnLoad').textContent = 'Laden';
  }
}

// Update main statistics
function updateStatistics(metrics) {
  const totals = metrics.totals || {};
  const funnel = metrics.funnel || {};
  
  // Main stats
  $('total-leads').textContent = totals.lead_submitted || 0;
  $('total-appointments').textContent = totals.appointment_booked || 0;
  $('total-members').textContent = totals.registered || 0;
  
  // Calculate overall conversion rate (leads to members)
  const conversionRate = totals.lead_submitted > 0 
    ? Math.round((totals.registered / totals.lead_submitted) * 100)
    : 0;
  
  const conversionEl = $('conversion-rate');
  conversionEl.textContent = conversionRate + '%';
  
  // Color code the conversion rate
  if (conversionRate >= 50) {
    conversionEl.className = 'stat-value success';
  } else if (conversionRate >= 25) {
    conversionEl.className = 'stat-value warning';
  } else {
    conversionEl.className = 'stat-value danger';
  }
}

// Update funnel visualization
function updateFunnel(metrics) {
  const totals = metrics.totals || {};
  const funnel = metrics.funnel || {};
  
  // Update counts
  $('funnel-clicks').textContent = totals.clicked || 0;
  $('funnel-leads').textContent = totals.lead_submitted || 0;
  $('funnel-appointments').textContent = totals.appointment_booked || 0;
  $('funnel-members').textContent = totals.registered || 0;
  
  // Update conversion rates
  $('funnel-leads-rate').textContent = (funnel.click_to_lead || 0) + '%';
  $('funnel-appointments-rate').textContent = (funnel.lead_to_appt || 0) + '%';
  $('funnel-members-rate').textContent = (funnel.appt_to_reg || 0) + '%';
}

// Update conversion chart
function updateChart(series) {
  // Process series data
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
  
  // Sort days and create arrays
  const days = Object.keys(byDay).sort();
  
  // Format dates for display
  const labels = days.map(d => {
    const date = new Date(d + 'T12:00:00');
    return date.toLocaleDateString('nl-NL', { 
      day: 'numeric', 
      month: 'short' 
    });
  });
  
  // Calculate conversion rates per day
  const conversionRates = days.map(day => {
    const data = byDay[day];
    if (data.lead_submitted === 0) return 0;
    return Math.round((data.registered / data.lead_submitted) * 100);
  });
  
  // Get data for each metric
  const leads = days.map(d => byDay[d].lead_submitted);
  const appointments = days.map(d => byDay[d].appointment_booked);
  const members = days.map(d => byDay[d].registered);
  
  // Chart configuration
  const chartData = {
    labels: labels,
    datasets: [
      {
        label: 'Conversie %',
        data: conversionRates,
        borderColor: '#10b981',
        backgroundColor: 'rgba(16, 185, 129, 0.1)',
        yAxisID: 'y-percentage',
        type: 'line',
        tension: 0.3,
        borderWidth: 3,
        pointRadius: 4,
        pointBackgroundColor: '#10b981'
      },
      {
        label: 'Leads',
        data: leads,
        backgroundColor: 'rgba(59, 130, 246, 0.6)',
        yAxisID: 'y-count',
        type: 'bar'
      },
      {
        label: 'Afspraken',
        data: appointments,
        backgroundColor: 'rgba(245, 158, 11, 0.6)',
        yAxisID: 'y-count',
        type: 'bar'
      },
      {
        label: 'Leden',
        data: members,
        backgroundColor: 'rgba(16, 185, 129, 0.6)',
        yAxisID: 'y-count',
        type: 'bar'
      }
    ]
  };
  
  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: 'index',
      intersect: false
    },
    plugins: {
      legend: {
        display: true,
        position: 'bottom',
        labels: {
          color: '#e5e7eb',
          padding: 15,
          font: {
            size: 12
          }
        }
      },
      tooltip: {
        backgroundColor: 'rgba(17, 24, 39, 0.95)',
        titleColor: '#f3f4f6',
        bodyColor: '#e5e7eb',
        borderColor: '#374151',
        borderWidth: 1,
        padding: 10,
        displayColors: true,
        callbacks: {
          label: function(context) {
            let label = context.dataset.label || '';
            if (label) {
              label += ': ';
            }
            if (context.parsed.y !== null) {
              if (context.dataset.yAxisID === 'y-percentage') {
                label += context.parsed.y + '%';
              } else {
                label += context.parsed.y;
              }
            }
            return label;
          }
        }
      }
    },
    scales: {
      x: {
        grid: {
          color: 'rgba(31, 41, 55, 0.5)'
        },
        ticks: {
          color: '#9ca3af',
          font: {
            size: 11
          }
        }
      },
      'y-count': {
        type: 'linear',
        display: true,
        position: 'left',
        grid: {
          color: 'rgba(31, 41, 55, 0.5)'
        },
        ticks: {
          color: '#9ca3af',
          font: {
            size: 11
          },
          precision: 0
        },
        title: {
          display: true,
          text: 'Aantal',
          color: '#9ca3af'
        }
      },
      'y-percentage': {
        type: 'linear',
        display: true,
        position: 'right',
        grid: {
          drawOnChartArea: false
        },
        ticks: {
          color: '#10b981',
          font: {
            size: 11
          },
          callback: function(value) {
            return value + '%';
          }
        },
        title: {
          display: true,
          text: 'Conversie %',
          color: '#10b981'
        },
        min: 0,
        max: 100
      }
    }
  };
  
  // Destroy existing chart if it exists
  if (conversionChart) {
    conversionChart.destroy();
  }
  
  // Create new chart
  const ctx = $('conversionChart').getContext('2d');
  conversionChart = new Chart(ctx, {
    type: 'bar',
    data: chartData,
    options: chartOptions
  });
}