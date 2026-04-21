/**
 * meta-pixel.js
 * Shared Meta Pixel tracking voor alle lead forms
 * Plaats dit bestand in: public/js/meta-pixel.js
 *
 * Verantwoordelijkheid: alleen PageView tracken op formulierpagina's.
 * Het Lead event wordt uitsluitend gevuurd op thankyou.html (browser)
 * en via de Conversions API (server) — met gedeelde event_id voor deduplicatie.
 */

(function() {
  'use strict';

  // Meta Pixel ID
  const PIXEL_ID = '662300986944267';

  // Initialize Meta Pixel
  !function(f,b,e,v,n,t,s) {
    if(f.fbq) return;
    n=f.fbq=function(){
      n.callMethod ? n.callMethod.apply(n,arguments) : n.queue.push(arguments)
    };
    if(!f._fbq) f._fbq=n;
    n.push=n;
    n.loaded=!0;
    n.version='2.0';
    n.queue=[];
    t=b.createElement(e);
    t.async=!0;
    t.src=v;
    s=b.getElementsByTagName(e)[0];
    s.parentNode.insertBefore(t,s)
  }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');

  // Init pixel
  fbq('init', PIXEL_ID);

  // Track PageView only — Lead event zit op thankyou.html
  fbq('track', 'PageView');

  console.log('✅ Meta Pixel loaded:', PIXEL_ID);

})();
