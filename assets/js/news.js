/*
 * News page: all announcements from /api/news, newest first, with year separators.
 * Requires assets/js/config.js and assets/js/site.js. Kept out of the HTML so the
 * page CSP can forbid inline scripts.
 */
DISLAB.load({
  target: 'newsContainer',
  paths: ['/api/news'],
  label: 'the news',
  skeletonCount: 3,
  render: function (data) {
    var el = document.getElementById('newsContainer');
    var items = DISLAB.sortNews(data);
    if (!items.length) { el.innerHTML = DISLAB.emptyHTML('No news yet', 'Announcements will appear here.'); return; }
    var html = '', lastYear;
    items.forEach(function (n) {
      var year = DISLAB.parseDate(n.date).year || 'Undated';
      if (year !== lastYear && !(year === 'Undated' && lastYear === undefined)) { html += '<li class="news-year" aria-hidden="true">' + year + '</li>'; lastYear = year; }
      html += DISLAB.newsItemHTML(n);
    });
    el.innerHTML = '<ul class="news-list">' + html + '</ul>';
  }
});
