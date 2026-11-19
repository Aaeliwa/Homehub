/*
 * Runs synchronously in <head> before CSS paints: applies the cached language/theme so
 * the first frame is already in the right direction and colour scheme (no flash), and
 * arms a watchdog that replaces the loading card with a message if the app never starts
 * (e.g. scripts blocked). Plain script, no modules, no Firebase.
 */
(function () {
  var html = document.documentElement;
  var prefs = {};
  try { prefs = JSON.parse(localStorage.getItem('homehub:prefs') || '{}') || {}; } catch (e) { prefs = {}; }
  var lang = prefs.language === 'en' ? 'en' : 'ar';
  var theme = prefs.theme === 'light' || prefs.theme === 'dark' ? prefs.theme
    : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  html.lang = lang;
  html.dir = lang === 'ar' ? 'rtl' : 'ltr';
  html.dataset.theme = theme;
  html.style.colorScheme = theme;

  setTimeout(function () {
    if (html.dataset.booted === '1') return;
    var status = document.getElementById('boot-status');
    if (status) {
      status.textContent = lang === 'ar'
        ? 'تعذّر تشغيل HomeHub. تحقق من اتصالك بالإنترنت ثم أعد تحميل الصفحة.'
        : 'HomeHub could not start. Check your internet connection, then reload the page.';
    }
  }, 15000);
})();
