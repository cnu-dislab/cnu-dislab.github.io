/*
 * Single source of truth for the lab API location.
 * Every page (public and admin) loads this file and reads window.DISLAB_API_BASE.
 *
 * Production value: https://www.nameyee.me
 *
 * Local development only: when the page itself is served from localhost/127.0.0.1,
 * the API defaults to http://127.0.0.1:8080. From a local page you can also pass
 *   ?api=prod                      -> use the production API
 *   ?api=http://127.0.0.1:9000     -> use another local API
 * (remembered for the browser tab). Overrides are ignored on the deployed site.
 */
(function () {
  var PRODUCTION = 'https://www.nameyee.me';
  var LOCAL_DEFAULT = 'http://127.0.0.1:8080';
  var LOCAL_HOST = /^(localhost|127\.0\.0\.1)$/;
  var LOCAL_URL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;
  var base = PRODUCTION;

  if (LOCAL_HOST.test(window.location.hostname)) {
    base = LOCAL_DEFAULT;
    try {
      var q = new URLSearchParams(window.location.search).get('api');
      if (q) { window.sessionStorage.setItem('dislabApi', q); }
      else { q = window.sessionStorage.getItem('dislabApi'); }
      if (q === 'prod') { base = PRODUCTION; }
      else if (q && LOCAL_URL.test(q)) { base = q; }
    } catch (e) { /* storage unavailable: keep the local default */ }
  }

  window.DISLAB_API_BASE = base;
})();
