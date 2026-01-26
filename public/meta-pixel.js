/**
 * meta-pixel.js
 * Shared Meta Pixel tracking voor alle lead forms
 * Plaats dit bestand in: public/js/meta-pixel.js
 */

(function() {
  'use strict';

  // Meta Pixel ID
  const PIXEL_ID = '1177365577340703';

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
  
  // Track PageView
  fbq('track', 'PageView');

  console.log('✅ Meta Pixel loaded:', PIXEL_ID);

  // Function to track Lead submission
  window.trackMetaLead = function(practiceCode) {
    if (typeof fbq !== 'undefined') {
      fbq('track', 'Lead', {
        content_name: 'Fysio Lead Form',
        content_category: 'Lead Generation',
        practice_code: practiceCode || 'unknown',
        value: 1.00,
        currency: 'EUR'
      });
      console.log('✅ Meta Lead event tracked for practice:', practiceCode);
    } else {
      console.warn('⚠️ Meta Pixel not loaded');
    }
  };

  // Auto-track lead on form submit
  // Zoekt naar form met class "lead-form" of id "leadForm"
  function setupFormTracking() {
    const form = document.querySelector('.lead-form, #leadForm, form[action*="leads"]');
    
    if (form) {
      form.addEventListener('submit', function(e) {
        // Get practice code from URL parameter or data attribute
        const urlParams = new URLSearchParams(window.location.search);
        const practiceCode = urlParams.get('s') || 
                            form.dataset.practice || 
                            document.body.dataset.practice || 
                            'unknown';
        
        // Track lead (non-blocking)
        setTimeout(() => {
          window.trackMetaLead(practiceCode);
        }, 0);
      });
      console.log('✅ Form tracking setup complete');
    }
  }

  // Setup when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupFormTracking);
  } else {
    setupFormTracking();
  }

})();
