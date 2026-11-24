/*
 * Page definitions for the admin area. Each admin HTML file sets
 * <body data-admin-page="..."> and loads this file; everything else is shared (admin.js).
 * Field names, limits and rules mirror the API's validation (db_server.py).
 */
(function () {
  'use strict';

  var A = window.DISADMIN;
  var D = window.DISLAB;
  var page = document.body.getAttribute('data-admin-page');

  var LINK_HINT = 'Must start with http:// or https://.';
  var IMAGE_HINT = 'A path inside this site (e.g. assets/photo.jpg — the file must be committed to the site repository) or a full http(s) URL.';

  function opts(list) { return list.map(function (v) { return Array.isArray(v) ? v : [v, v]; }); }

  /* ---------- publications ---------- */

  function publications() {
    return A.crud({
      key: 'paper', singular: 'publication', plural: 'publications', listTitle: 'Publications', filter: true,
      listPath: '/api/publications', addPath: '/api/add_paper', updatePath: '/api/update_paper', deletePath: '/api/delete_papers',
      name: function (p) { return p.title; },
      fields: [
        { name: 'title', label: 'Title', required: true, max: 500, wide: true },
        { name: 'authors', label: 'Authors', required: true, max: 1000, wide: true, placeholder: 'e.g. Gildong Hong, Heecheol Yang' },
        { name: 'category', label: 'Category', type: 'select', required: true, max: 100, custom: true,
          options: opts(['International Journal', 'International Conference', 'Domestic Journal', 'Domestic Conference', 'Preprint']),
          hint: 'The public page groups and filters by this value.' },
        { name: 'date', label: 'Date', required: true, max: 100, placeholder: 'e.g. Mar. 2024',
          hint: 'Free text; the year (and month) are read from it for sorting, e.g. “Mar. 2024”, “2024”, “May 8-9, 2014”.' },
        { name: 'event', label: 'Venue (short name)', required: true, max: 200, placeholder: 'e.g. IEEE TIFS' },
        { name: 'publication', label: 'Publication details', required: true, max: 500, placeholder: 'e.g. IEEE Trans. Inf. Forensics Security, vol. 19, pp. 1–12' },
        { name: 'url', label: 'Link', required: true, max: 2048, wide: true, placeholder: 'https://…',
          hint: LINK_HINT + ' Enter # if the paper has no link.' },
        { name: 'tags', label: 'Tags', max: 500, wide: true, placeholder: 'Comma-separated, e.g. Federated Learning, Privacy' }
      ],
      columns: [
        { label: 'Title', cls: 'col-main', render: function (p) { return A.stack(p.title, p.authors); } },
        { label: 'Category', render: function (p) { return p.category; } },
        { label: 'Venue', render: function (p) { return p.event; } },
        { label: 'Date', cls: 'col-nowrap', render: function (p) { return p.date; } },
        { label: 'Link', render: function (p) { return A.linkCell(p.url, 'Open'); } }
      ]
    });
  }

  /* ---------- members ---------- */

  var LEVELS = opts([
    ['Ph.D.', 'Ph.D. student'],
    ['Integrated', 'Integrated M.S./Ph.D. student'],
    ['Master', 'Master’s student'],
    ['Undergraduate', 'Undergraduate research student'],
    ['Alumni', 'Alumni']
  ]);
  var LEVEL_ORDER = LEVELS.map(function (l) { return l[0]; });

  function members() {
    var professor = A.single({
      key: 'professor', title: 'Professor', label: 'the professor’s profile',
      lead: 'Shown at the top of the public Members page.',
      loadPath: '/api/professor', savePath: '/api/professor',
      fields: [
        { name: 'name', label: 'Name', required: true, max: 100 },
        { name: 'position', label: 'Position', type: 'select', required: true, max: 100, custom: true,
          options: opts(['Assistant Professor', 'Associate Professor', 'Professor']) },
        { name: 'email', label: 'Email', type: 'email', required: true, max: 254 },
        { name: 'phone', label: 'Phone', max: 50, placeholder: 'e.g. 042-821-0000' },
        { name: 'photo', label: 'Photo', required: true, max: 500, wide: true, placeholder: 'assets/professor.jpg', hint: IMAGE_HINT },
        { name: 'address', label: 'Address', max: 300, wide: true },
        { name: 'education', label: 'Education', type: 'textarea', max: 10000, wide: true, rows: 3, hint: 'Separate entries with a semicolon (;). Each becomes a bullet.' },
        { name: 'research_experience', label: 'Research experience', type: 'textarea', max: 10000, wide: true, rows: 3, hint: 'Separate entries with a semicolon (;).' },
        { name: 'honors', label: 'Honors and awards', type: 'textarea', max: 10000, wide: true, rows: 3, hint: 'Separate entries with a semicolon (;).' },
        { name: 'academic_activities', label: 'Academic activities', type: 'textarea', max: 10000, wide: true, rows: 3, hint: 'Separate entries with a semicolon (;).' }
      ]
    });

    var students = A.crud({
      key: 'student', singular: 'student', plural: 'students', listTitle: 'Students',
      listPath: '/api/students', addPath: '/api/add_student', updatePath: '/api/update_student', deletePath: '/api/delete_students',
      name: function (s) { return s.name; },
      fields: [
        { name: 'name', label: 'Name', required: true, max: 100 },
        { name: 'level', label: 'Level', type: 'select', required: true, max: 50, custom: true, options: LEVELS,
          customPlaceholder: 'e.g. Postdoc',
          hint: 'Decides the section on the public Members page. A custom value gets its own section.' },
        { name: 'email', label: 'Email', type: 'email', required: true, max: 254 },
        { name: 'github', label: 'GitHub URL', max: 500, placeholder: 'https://github.com/username', hint: LINK_HINT + ' Leave empty if there is no profile.' },
        { name: 'photo', label: 'Photo', required: true, max: 500, wide: true, placeholder: 'assets/hong_gildong.jpg', hint: IMAGE_HINT }
      ],
      columns: [
        { label: 'Photo', cls: 'col-thumb', render: function (s) { return A.thumbCell(s.photo, ''); } },
        { label: 'Name', cls: 'col-main', render: function (s) { return A.stack(s.name, s.photo); } },
        { label: 'Level', render: function (s) { return s.level ? A.el('span', { class: 'badge', text: s.level }) : null; } },
        { label: 'Email', cls: 'col-break', render: function (s) { return s.email; } },
        { label: 'GitHub', cls: 'col-break', render: function (s) { return A.linkCell(s.github, String(s.github || '').replace(/^https?:\/\/(www\.)?/i, '')); } }
      ],
      sort: function (list) {
        function rank(s) { var i = LEVEL_ORDER.indexOf(s.level); return i === -1 ? LEVEL_ORDER.length : i; }
        return list.slice().sort(function (a, b) { return rank(a) - rank(b) || a.id - b.id; });
      }
    });

    return [professor].concat(students);
  }

  /* ---------- news ---------- */

  function news() {
    return A.crud({
      key: 'news', singular: 'news item', plural: 'news items', listTitle: 'News',
      listPath: '/api/news', addPath: '/api/add_news', updatePath: '/api/update_news', deletePath: '/api/delete_news',
      name: function (n) { return n.title; },
      fields: [
        { name: 'title', label: 'Title', required: true, max: 300, wide: true },
        { name: 'date', label: 'Date', type: 'date', required: true, max: 50, hint: 'News is listed newest first by this date.' },
        { name: 'url', label: '“Read more” link', max: 2048, placeholder: 'https://…', hint: 'An http(s) URL or a page of this site (e.g. publications.html). Leave empty for no link.',
          toForm: function (v) { return v === '#' ? '' : v; } },
        { name: 'snippet', label: 'Summary', type: 'textarea', max: 5000, wide: true, rows: 5 }
      ],
      columns: [
        { label: 'Date', cls: 'col-nowrap', render: function (n) { return n.date; } },
        { label: 'Title', cls: 'col-main', render: function (n) {
          var s = String(n.snippet || '');
          return A.stack(n.title, s.length > 140 ? s.slice(0, 140) + '…' : s);
        } },
        { label: 'Link', render: function (n) { return A.linkCell(n.url, 'Open'); } }
      ],
      sort: function (list) { return D.sortNews(list); }
    });
  }

  /* ---------- research ---------- */

  function research() {
    return A.crud({
      key: 'research', singular: 'research topic', plural: 'research topics', listTitle: 'Research topics',
      listPath: '/api/research', addPath: '/api/add_research', updatePath: '/api/update_research', deletePath: '/api/delete_research',
      name: function (r) { return r.title; },
      fields: [
        { name: 'title', label: 'Title', required: true, max: 300, wide: true },
        { name: 'image', label: 'Image', required: true, max: 500, wide: true, placeholder: 'assets/research_1.jpg', hint: IMAGE_HINT },
        { name: 'description', label: 'Description', type: 'textarea', max: 10000, wide: true, rows: 5,
          hint: 'One item per line; each line becomes a bullet on the public page.',
          /* Older records store line breaks as a literal "\n"; show them as real lines. */
          toForm: function (v) { return v.replace(/\\n/g, '\n'); } }
      ],
      columns: [
        { label: 'Image', cls: 'col-thumb', render: function (r) { return A.thumbCell(r.image, ''); } },
        { label: 'Title', cls: 'col-main', render: function (r) { return A.stack(r.title, r.image); } },
        { label: 'Description', render: function (r) {
          var lines = D.splitList(r.description, /\r?\n|\\n/);
          if (!lines.length) { return null; }
          return A.el('ul', { class: 'cell-list' }, lines.map(function (l) { return A.el('li', { text: l }); }));
        } }
      ]
    });
  }

  /* ---------- projects ---------- */

  function projects() {
    return A.crud({
      key: 'project', singular: 'project', plural: 'projects', listTitle: 'Projects',
      listPath: '/api/projects', addPath: '/api/add_project', updatePath: '/api/update_project', deletePath: '/api/delete_projects',
      name: function (p) { return p.title; },
      fields: [
        { name: 'title', label: 'Title', required: true, max: 300, wide: true },
        { name: 'start_month', label: 'Start month', type: 'month', required: true, placeholder: 'YYYY-MM', hint: 'Format YYYY-MM.' },
        { name: 'end_month', label: 'End month', type: 'month', required: true, placeholder: 'YYYY-MM', hint: 'Format YYYY-MM.' },
        { name: 'funding', label: 'Funding / sponsor', max: 300, wide: true, placeholder: 'e.g. National Research Foundation (NRF)' },
        { name: 'image', label: 'Image', max: 500, wide: true, placeholder: 'assets/project_1.jpg', hint: IMAGE_HINT + ' Leave empty for no image.' }
      ],
      columns: [
        { label: 'Title', cls: 'col-main', render: function (p) { return A.stack(p.title, p.image); } },
        { label: 'Period', cls: 'col-nowrap', render: function (p) { return (p.start_month || '?') + ' – ' + (p.end_month || '?'); } },
        { label: 'Funding', render: function (p) { return p.funding; } }
      ],
      sort: function (list) {
        return list.slice().sort(function (a, b) { return String(b.end_month).localeCompare(String(a.end_month)) || b.id - a.id; });
      }
    });
  }

  var PAGES = {
    publications: { title: 'Publications', lead: 'Add, edit and remove the papers listed on the public Publications page.', render: publications },
    members: { title: 'Members', lead: 'Edit the professor’s profile and manage the student list.', render: members },
    news: { title: 'News', lead: 'Post, edit and remove news items.', render: news },
    research: { title: 'Research', lead: 'Manage the research topics shown on the public Research page.', render: research },
    projects: { title: 'Projects', lead: 'Manage the funded projects shown on the public Projects page.', render: projects }
  };

  if (page === 'login') { A.login(); }
  else if (PAGES[page]) { A.start(PAGES[page]); }
})();
