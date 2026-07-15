/* ===========================================================
   pwa.js — registers the service worker (sw.js) that makes the
   app installable and fully usable offline. Kept separate from
   beat-timer.js since it's an unrelated responsibility.
   =========================================================== */

(() => {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      // Offline-install just won't be available on this origin/browser;
      // the app itself still works fine online.
    });
  });
})();
