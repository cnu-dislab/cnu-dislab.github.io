/*
 * Projects page: funded projects from /api/projects, grouped into ongoing / completed.
 * Requires assets/js/config.js and assets/js/site.js. Kept out of the HTML so the
 * page CSP can forbid inline scripts.
 */
DISLAB.load({
  target: 'projectsContainer',
  paths: ['/api/projects'],
  label: 'the project list',
  skeletonCount: 3,
  render: function (data) {
    var esc = DISLAB.esc;
    var el = document.getElementById('projectsContainer');
    var now = new Date();
    var nowKey = now.getFullYear() * 12 + now.getMonth() + 1;

    function key(d) { return d.year ? d.year * 12 + (d.month || 12) : null; }
    function label(raw, d) {
      if (!d.year) { return String(raw || ''); }
      return (d.month ? DISLAB.MONTH_NAMES[d.month - 1] + ' ' : '') + d.year;
    }

    var items = (Array.isArray(data) ? data : []).map(function (p) {
      var s = DISLAB.parseDate(p.start_month), e = DISLAB.parseDate(p.end_month);
      var endKey = key(e);
      return { p: p, s: s, e: e, startKey: key(s) || 0, ongoing: endKey === null ? null : endKey >= nowKey };
    }).sort(function (a, b) { return b.startKey - a.startKey || b.p.id - a.p.id; });

    if (!items.length) { el.innerHTML = DISLAB.emptyHTML('No projects listed yet', 'Please check back soon.'); return; }

    function card(it) {
      var p = it.p, img = DISLAB.safeUrl(p.image);
      var period = [label(p.start_month, it.s), label(p.end_month, it.e)].filter(Boolean).join(' – ');
      return '<article class="card project">' +
        (img ? '<div class="project-img" data-img-wrap><img src="' + esc(img) + '" alt="" loading="lazy" data-fallback="remove"></div>' : '') +
        '<h3>' + esc(p.title) + '</h3><dl>' +
        (period ? '<dt>Period</dt><dd>' + esc(period) + '</dd>' : '') +
        (p.funding ? '<dt>Funding</dt><dd>' + esc(p.funding) + '</dd>' : '') +
        '</dl></article>';
    }
    function group(title, list) {
      if (!list.length) { return ''; }
      return '<div class="group"><h2 class="section-title">' + title + ' <span class="count">' + list.length + '</span></h2>' +
        '<div class="grid-2">' + list.map(card).join('') + '</div></div>';
    }
    var ongoing = items.filter(function (i) { return i.ongoing === true; });
    var done = items.filter(function (i) { return i.ongoing === false; });
    var other = items.filter(function (i) { return i.ongoing === null; });
    el.innerHTML = group('Ongoing Projects', ongoing) + group('Completed Projects', done) + group('Other Projects', other);
    DISLAB.guardImages(el);
  }
});
