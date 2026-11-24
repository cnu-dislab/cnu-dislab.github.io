/*
 * Research page: research topic cards from /api/research.
 * Requires assets/js/config.js and assets/js/site.js. Kept out of the HTML so the
 * page CSP can forbid inline scripts.
 */
DISLAB.load({
  target: 'researchContainer',
  paths: ['/api/research'],
  label: 'the research topics',
  skeleton: 'cards',
  skeletonCount: 2,
  render: function (data) {
    var esc = DISLAB.esc;
    var el = document.getElementById('researchContainer');
    var items = (Array.isArray(data) ? data : []).slice().sort(function (a, b) { return a.id - b.id; });
    if (!items.length) { el.innerHTML = DISLAB.emptyHTML('No research topics listed yet', 'Please check back soon.'); return; }
    el.innerHTML = items.map(function (item) {
      var img = DISLAB.safeUrl(item.image);
      /* Lines are separated by a newline; some stored rows contain a literal "\\n" instead. */
      var lines = DISLAB.splitList(item.description, /\r?\n|\\n/);
      return '<article class="card research-card">' +
        (img ? '<div class="research-img" data-img-wrap><img src="' + esc(img) + '" alt="" loading="lazy" data-fallback="remove"></div>' : '') +
        '<div class="research-body"><h2>' + esc(item.title) + '</h2>' +
        (lines.length ? '<ul>' + lines.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul>' : '') +
        '</div></article>';
    }).join('');
    DISLAB.guardImages(el);
  }
});
