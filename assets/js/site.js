/*
 * Shared behaviour for the public pages: navigation, data loading with
 * loading / error / empty states, and small formatting helpers.
 * Requires assets/js/config.js to be loaded first.
 */
(function () {
  'use strict';

  var API_BASE = window.DISLAB_API_BASE || 'https://api.dnclab.dev';
  var TIMEOUT_MS = 12000;

  /* ---------- helpers ---------- */

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /*
   * Only http(s) and site-relative links are allowed through; "#" and blanks become ''.
   * Browsers strip control characters, tabs and newlines from URLs and read "\" as "/",
   * so "\x01javascript:..." or "java\nscript:..." would run script and "/\evil.com" would
   * leave the site: after trimming, anything with control characters, DEL, a backslash or
   * whitespace is rejected outright. The one exception is a plain space inside an http(s)
   * URL (stored Google Scholar search links contain them): the scheme is already fixed
   * there and the browser just percent-encodes the space.
   */
  var UNSAFE_URL_CHARS = /[\u0000-\u001f\u007f-\u009f\\]|[^\S ]/;
  function safeUrl(url) {
    var u = String(url == null ? '' : url).trim();
    if (!u || u === '#') { return ''; }
    if (UNSAFE_URL_CHARS.test(u)) { return ''; }
    if (/^https?:\/\//i.test(u)) { return u; }
    if (u.indexOf(' ') !== -1) { return ''; }
    if (/^[a-z][a-z0-9+.\-]*:/i.test(u) || u.indexOf('//') === 0) { return ''; }
    return u;
  }

  function splitList(value, separator) {
    return String(value == null ? '' : value)
      .split(separator)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  var MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /*
   * Free-form date -> { year, month, day } (null/0 when unknown).
   * Handles "Mar. 2024", "June. 2025", "2017. 2", "May 8-9, 2014", "2025",
   * "2025-02-18", "2024/03", "03/2024", "2024년 3월".
   */
  function parseDate(input) {
    var s = String(input == null ? '' : input);
    var out = { year: null, month: 0, day: 0 };

    var iso = s.match(/((?:19|20)\d{2})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})(?!\d)/);
    if (iso && +iso[2] >= 1 && +iso[2] <= 12 && +iso[3] >= 1 && +iso[3] <= 31) {
      return { year: +iso[1], month: +iso[2], day: +iso[3] };
    }

    var y = s.match(/(?:^|[^\d])((?:19|20)\d{2})(?!\d)/);
    if (y) { out.year = +y[1]; }

    var named = s.match(/(?:^|[^a-z])(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/i);
    if (named) {
      out.month = MONTHS[named[1].toLowerCase()];
      var d = s.slice(named.index + named[0].length).match(/^\.?\s*(\d{1,2})(?!\d)/);
      if (d && +d[1] >= 1 && +d[1] <= 31) { out.day = +d[1]; }
    } else if (out.year) {
      var after = s.match(/(?:19|20)\d{2}\s*[.\-\/년]\s*(\d{1,2})(?!\d)/);
      var before = s.match(/(?:^|[^\d])(\d{1,2})\s*[.\-\/]\s*(?:19|20)\d{2}(?!\d)/);
      var m = after ? +after[1] : (before ? +before[1] : 0);
      if (m >= 1 && m <= 12) { out.month = m; }
    }
    return out;
  }

  /* Newest first; entries with less precise or missing dates sort after dated ones. */
  function compareDatesDesc(a, b) {
    if (a.year !== b.year) { return (b.year || -1) - (a.year || -1); }
    if (a.month !== b.month) { return b.month - a.month; }
    return b.day - a.day;
  }

  /* ---------- data loading ---------- */

  function fetchJSON(path) {
    var controller = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) { controller.abort(); } }, TIMEOUT_MS);
    return fetch(API_BASE + path, controller ? { signal: controller.signal } : undefined)
      .then(function (res) {
        if (!res.ok) { throw new Error('HTTP ' + res.status); }
        return res.json();
      })
      .finally(function () { clearTimeout(timer); });
  }

  var ICONS = {
    error: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4.5"/><circle cx="12" cy="17.2" r=".6" fill="currentColor"/></svg>',
    empty: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5.5 5h13L21 13v6H3v-6l2.5-8z"/></svg>'
  };

  function stateHTML(kind, title, text, withRetry) {
    return '<div class="state state--' + kind + '" role="' + (kind === 'error' ? 'alert' : 'status') + '">' +
      '<div class="state-icon">' + ICONS[kind] + '</div>' +
      '<p class="state-title">' + esc(title) + '</p>' +
      (text ? '<p class="state-text">' + esc(text) + '</p>' : '') +
      (withRetry ? '<button type="button" class="btn btn--outline" data-retry>Try again</button>' : '') +
      '</div>';
  }

  function skeletonHTML(count, variant) {
    var html = '<div class="skeleton-list skeleton-list--' + (variant || 'rows') + '" aria-hidden="true">';
    for (var i = 0; i < (count || 3); i++) {
      html += '<div class="skeleton"><span></span><span></span><span></span></div>';
    }
    return html + '</div><p class="sr-only" role="status">Loading…</p>';
  }

  /*
   * load({ target, paths, render, label, skeleton, skeletonCount, onError })
   *   target   element (or id) that receives loading / error markup
   *   paths    array of API paths, fetched in parallel
   *   render   function(results...) called on success; it fills the page itself
   *   label    human name of the content, used in the error message
   */
  function load(opts) {
    var target = typeof opts.target === 'string' ? document.getElementById(opts.target) : opts.target;
    if (!target) { return; }

    function attempt() {
      target.setAttribute('aria-busy', 'true');
      target.innerHTML = skeletonHTML(opts.skeletonCount, opts.skeleton);
      Promise.all(opts.paths.map(fetchJSON)).then(function (results) {
        target.removeAttribute('aria-busy');
        target.innerHTML = '';
        opts.render.apply(null, results);
      }).catch(function (err) {
        if (window.console) { console.error('[DIS Lab] Failed to load ' + opts.paths.join(', '), err); }
        target.removeAttribute('aria-busy');
        if (opts.onError) { opts.onError(err); }
        target.innerHTML = stateHTML(
          'error',
          'We couldn’t load ' + (opts.label || 'this content') + ' right now',
          'The lab’s data server is not responding. Please try again in a moment.',
          true
        );
        var retry = target.querySelector('[data-retry]');
        if (retry) { retry.addEventListener('click', attempt); }
      });
    }
    attempt();
  }

  function emptyHTML(title, text) { return stateHTML('empty', title, text, false); }

  /* Replace a broken image with a neutral placeholder (or remove it). */
  function guardImages(root) {
    Array.prototype.forEach.call(root.querySelectorAll('img[data-fallback]'), function (img) {
      function fail() {
        var mode = img.getAttribute('data-fallback');
        if (mode === 'remove') {
          var wrap = img.closest('[data-img-wrap]') || img;
          wrap.parentNode.removeChild(wrap);
          return;
        }
        var ph = document.createElement('div');
        ph.className = 'avatar-fallback ' + (img.className || '');
        ph.setAttribute('aria-hidden', 'true');
        ph.textContent = mode || '';
        img.parentNode.replaceChild(ph, img);
      }
      if (img.complete && img.naturalWidth === 0) { fail(); }
      else { img.addEventListener('error', fail, { once: true }); }
    });
  }

  /* ---------- news ---------- */

  function sortNews(list) {
    return (Array.isArray(list) ? list : []).map(function (n) {
      return { n: n, d: parseDate(n.date) };
    }).sort(function (a, b) {
      return compareDatesDesc(a.d, b.d) || (b.n.id || 0) - (a.n.id || 0);
    }).map(function (x) { return x.n; });
  }

  function formatDate(raw) {
    var s = String(raw == null ? '' : raw).trim();
    var d = parseDate(s);
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s) && d.year) {
      return MONTH_NAMES[d.month - 1] + ' ' + d.day + ', ' + d.year;
    }
    return s;
  }

  function newsItemHTML(n) {
    var url = safeUrl(n.url);
    var date = formatDate(n.date);
    return '<li class="card news-item">' +
      '<div class="news-date">' + esc(date) + '</div>' +
      '<div><h3>' + esc(n.title) + '</h3>' +
      (n.snippet ? '<p>' + esc(n.snippet) + '</p>' : '') +
      (url ? '<a class="more" href="' + esc(url) + '" target="_blank" rel="noopener">Read more &rarr;</a>' : '') +
      '</div></li>';
  }

  /* ---------- navigation ---------- */

  function initNav() {
    var header = document.querySelector('.site-header');
    if (!header) { return; }
    var toggle = header.querySelector('.nav-toggle');
    var nav = header.querySelector('.site-nav');

    var page = window.location.pathname.split('/').pop() || 'index.html';
    Array.prototype.forEach.call(nav.querySelectorAll('a'), function (a) {
      if (a.getAttribute('href') === page) { a.setAttribute('aria-current', 'page'); }
    });

    if (toggle) {
      toggle.addEventListener('click', function () {
        var open = header.classList.toggle('nav-open');
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && header.classList.contains('nav-open')) {
          header.classList.remove('nav-open');
          toggle.setAttribute('aria-expanded', 'false');
          toggle.focus();
        }
      });
    }
  }

  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', initNav); }
  else { initNav(); }

  window.DISLAB = {
    API_BASE: API_BASE,
    MONTH_NAMES: MONTH_NAMES,
    esc: esc,
    safeUrl: safeUrl,
    splitList: splitList,
    parseDate: parseDate,
    compareDatesDesc: compareDatesDesc,
    fetchJSON: fetchJSON,
    sortNews: sortNews,
    formatDate: formatDate,
    newsItemHTML: newsItemHTML,
    load: load,
    emptyHTML: emptyHTML,
    guardImages: guardImages
  };
})();
