/*
 * V6.3 installed-app support (plain script, no Firebase). Registers the network-only service worker so
 * Chrome can install HomeHub as a standalone app (no URL bar) instead of a home-screen shortcut.
 * Skipped under browser automation and on insecure origins (service workers need https or localhost).
 */
(function () {
  if (!('serviceWorker' in navigator) || navigator.webdriver) return;
  var secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (!secure) return;
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(function (reg) {
      // pick up a new worker promptly; it never caches app code, so updating is always safe
      if (reg && reg.update) reg.update().catch(function () {});
    }).catch(function () { /* the app works fine without it */ });
  });
})();
