// Lichtgewicht presence-heartbeat voor pagina's buiten het hoofddashboard.
// Werkt last_seen_at op de server bij zolang de gebruiker actief is.
// Faalt stil wanneer er geen (ingelogde) sessie is.
(function () {
  var INTERVAL = 5 * 60 * 1000; // 5 minuten
  var lastActivity = Date.now();

  ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart', 'click'].forEach(function (evt) {
    document.addEventListener(evt, function () { lastActivity = Date.now(); }, true);
  });

  function beat() {
    // Alleen een heartbeat sturen als er recent activiteit was.
    if (Date.now() - lastActivity < INTERVAL) {
      fetch('/api/auth/heartbeat', { method: 'POST', credentials: 'include' }).catch(function () {});
    }
  }

  setInterval(beat, INTERVAL);
})();
