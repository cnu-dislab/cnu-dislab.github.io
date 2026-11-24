/*
 * Home page (index.html): the three latest news items and the decorative
 * animated network hero (three.js + vanta.net, both served from this site).
 * Requires assets/js/config.js and assets/js/site.js. Kept out of the HTML so the
 * page CSP can forbid inline scripts.
 */
DISLAB.load({
  target: 'homeNews',
  paths: ['/api/news'],
  label: 'the latest news',
  skeletonCount: 2,
  render: function (news) {
    var el = document.getElementById('homeNews');
    var items = DISLAB.sortNews(news).slice(0, 3);
    el.innerHTML = items.length
      ? '<ul class="news-list">' + items.map(DISLAB.newsItemHTML).join('') + '</ul>'
      : DISLAB.emptyHTML('No news yet', 'Announcements will appear here.');
  }
});

/* Animated network background: purely decorative, loaded after the content
   and skipped when the visitor prefers reduced motion or WebGL is missing. */
(function () {
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) { return; }
  function add(src, next) {
    var s = document.createElement('script');
    s.src = src; s.onload = next;
    document.body.appendChild(s);
  }
  window.addEventListener('load', function () {
    add('three.min.js', function () {
      add('dist/vanta.net.min.js', function () {
        try {
          VANTA.NET({
            el: '#hero-bg',
            mouseControls: true,
            touchControls: true,
            gyroControls: false,
            minHeight: 200.0,
            minWidth: 200.0,
            scale: 1.0,
            scaleMobile: 1.0,
            color: 0xffffff,
            backgroundColor: 0x002554,
            points: 20
          });
        } catch (e) { /* the plain navy hero remains */ }
      });
    });
  });
})();
