/*
 * Publications page: fetches /api/publications, sorts newest first using a
 * tolerant client-side date parser, groups by year, and provides category
 * filter, search and copy-citation buttons.
 * Requires assets/js/config.js and assets/js/site.js.
 */
(function () {
  'use strict';

  var D = window.DISLAB;
  var esc = D.esc;

  /* Display order of the category filter. Unknown categories are appended after these. */
  var CATEGORY_ORDER = [
    'International Journal',
    'International Conference',
    'Domestic Journal',
    'Domestic Conference',
    'Preprint'
  ];
  var ALL = 'All';

  var els = {
    toolbar: document.getElementById('pubToolbar'),
    search: document.getElementById('pubSearch'),
    chips: document.getElementById('pubChips'),
    summary: document.getElementById('pubSummary'),
    jump: document.getElementById('yearJump'),
    list: document.getElementById('pubList')
  };

  var papers = [];
  var byId = {};
  var state = { category: ALL, query: '' };

  /* ---------- data preparation ---------- */

  function kindOf(category) {
    var c = String(category || '').toLowerCase();
    if (c.indexOf('journal') !== -1) { return 'journal'; }
    if (c.indexOf('conference') !== -1) { return 'conf'; }
    if (c.indexOf('preprint') !== -1) { return 'preprint'; }
    return 'other';
  }

  function prepare(raw) {
    return (Array.isArray(raw) ? raw : []).map(function (p) {
      var item = {
        id: p.id,
        url: D.safeUrl(p.url),
        category: String(p.category || '').trim() || 'Other',
        event: String(p.event || '').trim(),
        title: String(p.title || '').trim(),
        authors: String(p.authors || '').trim(),
        date: String(p.date || '').trim(),
        publication: String(p.publication || '').trim(),
        tags: D.splitList(p.tags, ',')
      };
      item.when = D.parseDate(item.date);
      item.kind = kindOf(item.category);
      item.haystack = [item.title, item.authors, item.publication, item.event, item.category, item.date, item.tags.join(' ')]
        .join(' ').toLowerCase();
      return item;
    }).sort(function (a, b) {
      return D.compareDatesDesc(a.when, b.when) || (b.id || 0) - (a.id || 0);
    });
  }

  /* ---------- citations ---------- */

  function authorList(authors) {
    return authors.replace(/\*/g, '')
      .split(/\s*[,;]\s*(?:and\s+)?|\s+and\s+/i)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  function reference(p) {
    var names = authorList(p.authors);
    var who = names.length > 2
      ? names.slice(0, -1).join(', ') + ', and ' + names[names.length - 1]
      : names.join(' and ');
    var parts = [];
    if (who) { parts.push(who); }
    parts.push('"' + p.title + (p.publication || p.date ? ',"' : '."'));
    var tail = [p.publication, p.date.replace(/\.$/, '')].filter(Boolean).join(', ');
    return parts.join(', ') + (tail ? ' ' + tail + '.' : '');
  }

  function bibKey(p) {
    var first = authorList(p.authors)[0] || '';
    var last = (first.split(/\s+/).pop() || '').toLowerCase().replace(/[^a-z]/g, '');
    var word = (p.title.toLowerCase().match(/[a-z]{4,}/) || [''])[0];
    var key = last + (p.when.year || '') + word;
    return last ? key : 'dislab' + (p.id || '');
  }

  function bibValue(s) { return String(s).replace(/[{}]/g, '').replace(/([&%#_$])/g, '\\$1'); }

  function bibtex(p) {
    var type = p.kind === 'journal' ? 'article' : (p.kind === 'conf' ? 'inproceedings' : 'misc');
    var venueField = p.kind === 'journal' ? 'journal' : (p.kind === 'conf' ? 'booktitle' : 'howpublished');
    var fields = [
      ['title', '{' + bibValue(p.title) + '}'],
      ['author', bibValue(authorList(p.authors).join(' and '))]
    ];
    if (p.publication) { fields.push([venueField, bibValue(p.publication)]); }
    if (p.when.year) { fields.push(['year', String(p.when.year)]); }
    if (p.when.month) { fields.push(['month', D.MONTH_NAMES[p.when.month - 1].toLowerCase()]); }
    if (p.url) { fields.push(['url', p.url.replace(/[{}]/g, '')]); }
    return '@' + type + '{' + bibKey(p) + ',\n' +
      fields.map(function (f) { return '  ' + f[0] + ' = {' + f[1] + '}'; }).join(',\n') + '\n}';
  }

  function legacyCopy(text) {
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      if (ok) { resolve(); } else { reject(new Error('copy failed')); }
    });
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(function () { return legacyCopy(text); });
    }
    return legacyCopy(text);
  }

  /* ---------- rendering ---------- */

  function authorsHTML(authors) {
    /* Highlight the lab's PI in the author list. */
    return esc(authors).replace(/(Heecheol Yang\*?|H\. Yang\*?|양희철\*?)/g, '<strong>$1</strong>');
  }

  function paperHTML(p) {
    var title = esc(p.title);
    var venue = [p.publication ? '<em>' + esc(p.publication) + '</em>' : '', esc(p.date)].filter(Boolean).join(' · ');
    return '<li class="pub">' +
      '<div class="pub-meta">' +
        (p.event ? '<span class="badge badge--' + p.kind + '">' + esc(p.event) + '</span>' : '') +
        '<span>' + esc(p.category) + '</span>' +
      '</div>' +
      '<h3 class="pub-title">' +
        (p.url ? '<a href="' + esc(p.url) + '" target="_blank" rel="noopener">' + title + '</a>' : title) +
      '</h3>' +
      (p.authors ? '<p class="pub-authors">' + authorsHTML(p.authors) + '</p>' : '') +
      (venue ? '<p class="pub-venue">' + venue + '</p>' : '') +
      '<div class="pub-foot">' +
        '<ul class="tags">' + p.tags.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>' +
        '<div class="pub-actions">' +
          '<button type="button" class="btn btn--outline btn--small" data-copy="bibtex" data-id="' + esc(p.id) + '">Copy BibTeX</button>' +
          '<button type="button" class="btn btn--outline btn--small" data-copy="reference" data-id="' + esc(p.id) + '">Copy reference</button>' +
        '</div>' +
      '</div>' +
    '</li>';
  }

  function categories() {
    var counts = {};
    papers.forEach(function (p) { counts[p.category] = (counts[p.category] || 0) + 1; });
    var names = CATEGORY_ORDER.filter(function (c) { return counts[c]; })
      .concat(Object.keys(counts).filter(function (c) { return CATEGORY_ORDER.indexOf(c) === -1; }).sort());
    return names.map(function (c) { return { name: c, count: counts[c] }; });
  }

  function renderChips() {
    var list = [{ name: ALL, count: papers.length }].concat(categories());
    els.chips.innerHTML = list.map(function (c) {
      return '<button type="button" class="chip" data-category="' + esc(c.name) + '" aria-pressed="' +
        (c.name === state.category ? 'true' : 'false') + '">' + esc(c.name) + ' <span class="n">' + c.count + '</span></button>';
    }).join('');
  }

  function render() {
    var words = state.query.toLowerCase().split(/\s+/).filter(Boolean);
    var inCategory = papers.filter(function (p) { return state.category === ALL || p.category === state.category; });
    var shown = inCategory.filter(function (p) {
      return words.every(function (w) { return p.haystack.indexOf(w) !== -1; });
    });

    Array.prototype.forEach.call(els.chips.querySelectorAll('.chip'), function (chip) {
      chip.setAttribute('aria-pressed', chip.getAttribute('data-category') === state.category ? 'true' : 'false');
    });

    var noun = function (n) { return n === 1 ? 'publication' : 'publications'; };
    els.summary.textContent = words.length
      ? shown.length + ' of ' + inCategory.length + ' ' + noun(inCategory.length) + ' match “' + state.query.trim() + '”'
      : shown.length + ' ' + noun(shown.length) + (state.category === ALL ? '' : ' in ' + state.category);

    if (!shown.length) {
      els.jump.innerHTML = '';
      els.list.innerHTML = '<div style="margin-top:20px">' + D.emptyHTML(
        papers.length ? 'No publications match your search' : 'No publications listed yet',
        papers.length ? 'Try a different keyword or another category.' : 'Please check back soon.'
      ) + '</div>';
      return;
    }

    var groups = [];
    shown.forEach(function (p) {
      var label = p.when.year ? String(p.when.year) : 'Undated';
      var g = groups[groups.length - 1];
      if (!g || g.label !== label) { g = { label: label, items: [] }; groups.push(g); }
      g.items.push(p);
    });

    els.jump.innerHTML = groups.length > 2
      ? '<span>Jump to</span>' + groups.map(function (g) {
          return '<a href="#y' + esc(g.label) + '">' + esc(g.label) + '</a>';
        }).join('')
      : '';

    els.list.innerHTML = groups.map(function (g) {
      return '<section class="year-group" id="y' + esc(g.label) + '">' +
        '<h2 class="year-heading">' + esc(g.label) + ' <span class="count">' + g.items.length + '</span></h2>' +
        '<ul class="pub-list">' + g.items.map(paperHTML).join('') + '</ul></section>';
    }).join('');
  }

  /* ---------- events ---------- */

  els.chips.addEventListener('click', function (e) {
    var chip = e.target.closest('.chip');
    if (!chip) { return; }
    state.category = chip.getAttribute('data-category');
    render();
  });

  els.search.addEventListener('input', function () {
    state.query = els.search.value;
    render();
  });

  els.list.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-copy]');
    if (!btn) { return; }
    var p = byId[btn.getAttribute('data-id')];
    if (!p) { return; }
    var original = btn.getAttribute('data-label') || btn.textContent;
    btn.setAttribute('data-label', original);
    copyText(btn.getAttribute('data-copy') === 'bibtex' ? bibtex(p) : reference(p)).then(function () {
      btn.textContent = 'Copied';
      btn.classList.add('is-copied');
    }, function () {
      btn.textContent = 'Copy failed';
    }).then(function () {
      setTimeout(function () {
        btn.textContent = original;
        btn.classList.remove('is-copied');
      }, 1600);
    });
  });

  /* ---------- start ---------- */

  D.load({
    target: els.list,
    paths: ['/api/publications'],
    label: 'the publication list',
    skeletonCount: 5,
    onError: function () {
      els.toolbar.hidden = true;
      els.summary.textContent = '';
      els.jump.innerHTML = '';
    },
    render: function (data) {
      papers = prepare(data);
      byId = {};
      papers.forEach(function (p) { byId[String(p.id)] = p; });
      els.toolbar.hidden = papers.length === 0;
      renderChips();
      render();
    }
  });

  /* Exposed for testing in the browser console. */
  D.publications = { reference: reference, bibtex: bibtex };
})();
