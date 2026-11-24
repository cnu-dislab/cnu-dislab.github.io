/*
 * Members page: professor card and student groups from /api/professor and /api/students.
 * Requires assets/js/config.js and assets/js/site.js. Kept out of the HTML so the
 * page CSP can forbid inline scripts.
 */
(function () {
  var esc = DISLAB.esc;
  var ICON = {
    mail: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/></svg>',
    phone: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/></svg>',
    pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
    code: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 7-5 5 5 5M16 7l5 5-5 5"/></svg>'
  };
  /* Section order and headings; any other level value gets its own section after these. */
  var LEVELS = [
    ['Postdoc', 'Postdoctoral Researchers'],
    ['Ph.D.', 'Ph.D. Students'],
    ['PhD', 'Ph.D. Students'],
    ['Integrated', 'Integrated M.S./Ph.D. Students'],
    ['Master', 'Master’s Students'],
    ['Undergraduate', 'Undergraduate Research Students'],
    ['Alumni', 'Alumni']
  ];

  function initials(name) {
    return String(name || '').trim().split(/\s+/).map(function (w) { return w.charAt(0); }).join('').slice(0, 2).toUpperCase();
  }

  function infoCard(title, value) {
    var items = DISLAB.splitList(value, ';');
    if (!items.length) { return ''; }
    return '<div class="card info-card"><h3>' + title + '</h3><ul>' +
      items.map(function (i) { return '<li>' + esc(i) + '</li>'; }).join('') + '</ul></div>';
  }

  function professorHTML(p) {
    if (!p || !p.name) { return ''; }
    var photo = DISLAB.safeUrl(p.photo);
    var lines = '';
    if (p.email) { lines += '<li>' + ICON.mail + '<a href="mailto:' + esc(p.email) + '">' + esc(p.email) + '</a></li>'; }
    if (p.phone) { lines += '<li>' + ICON.phone + '<span>' + esc(p.phone) + '</span></li>'; }
    if (p.address) { lines += '<li>' + ICON.pin + '<span>' + esc(p.address) + '</span></li>'; }
    return '<div class="group"><h2 class="section-title">Professor</h2>' +
      '<div class="card prof">' +
        (photo
          ? '<img class="prof-photo" src="' + esc(photo) + '" alt="' + esc(p.name) + '" data-fallback="' + esc(initials(p.name)) + '">'
          : '<div class="avatar-fallback prof-photo" aria-hidden="true">' + esc(initials(p.name)) + '</div>') +
        '<div><h2>' + esc(p.name) + '</h2>' +
        (p.position ? '<p class="prof-position">' + esc(p.position) + '</p>' : '') +
        '<ul class="contact-lines">' + lines + '</ul></div>' +
      '</div>' +
      '<div class="info-grid">' +
        infoCard('Education', p.education) +
        infoCard('Research Experience', p.research_experience) +
        infoCard('Honors and Awards', p.honors) +
        infoCard('Academic Activities', p.academic_activities) +
      '</div></div>';
  }

  function studentHTML(s) {
    var photo = DISLAB.safeUrl(s.photo);
    var github = DISLAB.safeUrl(s.github);
    return '<li class="card person">' +
      (photo
        ? '<img class="person-photo" src="' + esc(photo) + '" alt="" loading="lazy" data-fallback="' + esc(initials(s.name)) + '">'
        : '<div class="avatar-fallback person-photo" aria-hidden="true">' + esc(initials(s.name)) + '</div>') +
      '<h3>' + esc(s.name) + '</h3>' +
      (s.email ? '<p class="person-email">' + esc(s.email) + '</p>' : '') +
      '<div class="person-links">' +
        (s.email ? '<a href="mailto:' + esc(s.email) + '">' + ICON.mail + 'Email</a>' : '') +
        (github ? '<a href="' + esc(github) + '" target="_blank" rel="noopener">' + ICON.code + 'GitHub</a>'
                : '<span class="is-disabled" aria-disabled="true" title="No GitHub profile">' + ICON.code + 'GitHub</span>') +
      '</div></li>';
  }

  function studentsHTML(students) {
    var groups = [], byTitle = {};
    function group(title) {
      if (!byTitle[title]) { byTitle[title] = { title: title, items: [] }; groups.push(byTitle[title]); }
      return byTitle[title];
    }
    LEVELS.forEach(function (l) { group(l[1]); });
    (students || []).forEach(function (s) {
      var level = String(s.level || '').trim();
      var known = LEVELS.filter(function (l) { return l[0].toLowerCase() === level.toLowerCase(); })[0];
      group(known ? known[1] : (level || 'Members')).items.push(s);
    });
    return groups.filter(function (g) { return g.items.length; }).map(function (g) {
      return '<div class="group"><h2 class="section-title">' + esc(g.title) +
        ' <span class="count">' + g.items.length + '</span></h2>' +
        '<ul class="people">' + g.items.map(studentHTML).join('') + '</ul></div>';
    }).join('');
  }

  DISLAB.load({
    target: 'membersRoot',
    paths: ['/api/professor', '/api/students'],
    label: 'the member list',
    skeleton: 'cards',
    skeletonCount: 4,
    render: function (professor, students) {
      var root = document.getElementById('membersRoot');
      var html = professorHTML(professor) + studentsHTML(Array.isArray(students) ? students : []);
      root.innerHTML = html || DISLAB.emptyHTML('No members listed yet', 'Please check back soon.');
      DISLAB.guardImages(root);
    }
  });
})();
