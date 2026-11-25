/*
 * Chat assistant for the admin pages: a floating launcher (bottom-right) that opens a chat
 * panel. The admin writes loosely, pastes a link or attaches a PDF / screenshot; the server
 * answers with text plus "proposals" (add / update / delete), and nothing is changed until
 * the admin presses Apply on a proposal.
 *
 * Loaded after admin.js + admin-pages.js on the admin pages only (not login.html).
 * Starts when admin.js has verified the session ('dislab-admin-ready').
 *
 * API (Bearer auth through DISADMIN.request):
 *   POST /api/assistant        { messages: [{ role, text }], attachments: [{ name, media_type, data }] }
 *   POST /api/assistant/apply  { proposals: [{ id, entity, action, target_id, fields }] }
 *
 * Security notes (same rules as admin.js):
 *   - Replies, summaries and field values are model output and may quote fetched web pages.
 *     Everything is written with textContent / DOM nodes; there is no innerHTML in this file.
 *   - Links from model text are only rendered for http(s) URLs, with rel="noopener noreferrer".
 *   - sessionStorage keeps the conversation text only: never attachments, never the token.
 *   - No inline styles in markup (CSP); the only CSSOM use is the textarea's auto height.
 */
(function () {
  'use strict';

  var A = window.DISADMIN;
  var page = document.body.getAttribute('data-admin-page');
  if (!A || typeof A.request !== 'function' || !page || page === 'login') { return; }

  var el = A.el;

  /* ---------- limits (mirror the API) ---------- */

  var MAX_FILES = 5;
  var MAX_TOTAL_BYTES = 8 * 1024 * 1024;
  var MAX_MESSAGES = 40;
  var MAX_CHARS = 8000;
  var TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'text/plain'];
  var EXT_TYPES = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', txt: 'text/plain' };
  var ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,' + TYPES.join(',');

  var ASK_TIMEOUT_MS = 5 * 60 * 1000;   /* the call can take a couple of minutes */
  var APPLY_TIMEOUT_MS = 60 * 1000;
  var STORE_KEY = 'dislabAssistant';    /* sessionStorage */
  var NO_TEXT = 'Please look at the attached file(s).';

  /*
   * The API only receives each turn's text. So that follow-ups such as "same, but change the
   * year" work, the assistant's earlier proposals (and whether they were applied) are appended
   * to that turn's text as a bracketed note. Set to false to send the reply text only.
   */
  var SEND_PROPOSAL_CONTEXT = true;

  /* entity -> label, the admin page that lists it, and that page's panel key in admin-pages.js */
  var ENTITIES = {
    papers: { label: 'Publication', page: 'publications', href: 'admin5504.html', pageLabel: 'Publications', key: 'paper' },
    news: { label: 'News', page: 'news', href: 'admin_news.html', pageLabel: 'News', key: 'news' },
    student: { label: 'Student', page: 'members', href: 'admin_members.html', pageLabel: 'Members', key: 'student' },
    professor: { label: 'Professor', page: 'members', href: 'admin_members.html', pageLabel: 'Members', key: 'professor' },
    research: { label: 'Research topic', page: 'research', href: 'admin_research.html', pageLabel: 'Research', key: 'research' },
    projects: { label: 'Project', page: 'projects', href: 'admin_projects.html', pageLabel: 'Projects', key: 'project' }
  };
  var ACTIONS = { add: 'Add', update: 'Update', 'delete': 'Delete' };
  var FIELD_LABELS = {
    title: 'Title', authors: 'Authors', category: 'Category', date: 'Date', event: 'Venue', publication: 'Publication details',
    url: 'Link', tags: 'Tags', name: 'Name', level: 'Level', email: 'Email', github: 'GitHub', photo: 'Photo',
    position: 'Position', phone: 'Phone', address: 'Address', education: 'Education', research_experience: 'Research experience',
    honors: 'Honors and awards', academic_activities: 'Academic activities', snippet: 'Summary', image: 'Image',
    description: 'Description', start_month: 'Start month', end_month: 'End month', funding: 'Funding / sponsor'
  };
  var LONG_VALUE = 260;

  var EXAMPLES = [
    { label: 'Add a paper from its link', text: 'Add this paper to Publications: ' },
    { label: 'Add papers from a PDF or screenshot', text: 'Add the publications listed in the attached file.', attach: true },
    { label: 'Fix a member’s email', text: 'Change the email of (name) to ' },
    { label: 'Post a news item', text: 'Post a news item: ' }
  ];

  /* ---------- state ---------- */

  var state = { user: '', open: false, draft: '', messages: [] };
  var seq = 0;                 /* local message ids */
  var attachments = [];        /* composer: [{ name, media_type, size, data, preview }] — memory only */
  var sentFiles = {};          /* message id -> attachments, kept in memory for "Try again" */
  var busy = false;            /* a question is in flight */
  var applying = false;        /* an apply call is in flight */
  var abortCtl = null;
  var waitStart = 0;
  var waitTimer = null;
  var reading = 0;             /* files still being read */
  var unread = false;
  var started = false;
  var ui = {};

  /* ---------- small helpers ---------- */

  function svgIcon(paths, cls) {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('class', 'asst-icon' + (cls ? ' ' + cls : ''));
    paths.forEach(function (d) {
      var p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    });
    return svg;
  }
  var ICON = {
    chat: ['M4 5.5h16v10.5H10.5L6 19.8V16H4z', 'M8 9.5h8', 'M8 12.5h5'],
    close: ['M6 9l6 6 6-6'],
    fresh: ['M12 5v14', 'M5 12h14'],
    clip: ['M20 11.5l-7.8 7.8a5 5 0 0 1-7-7l8-8a3.3 3.3 0 0 1 4.700 4.700l-8 8a1.700 1.700 0 0 1-2.400-2.400l7.300-7.300'],
    send: ['M12 19V5', 'M6 11l6-6 6 6'],
    x: ['M6 6l12 12', 'M18 6L6 18'],
    file: ['M7 3.5h7l4 4v13H7z', 'M14 3.5v4h4'],
    check: ['M5 12.5l4.500 4.500L19 7.500'],
    info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 11v5.500', 'M12 7.800v.2'],
    warn: ['M12 3.500L2.500 20h19z', 'M12 10v4.500', 'M12 17.200v.2']
  };

  function clear(node) { while (node.firstChild) { node.removeChild(node.firstChild); } }

  function iconButton(icon, label, cls, onClick) {
    var b = el('button', { type: 'button', class: cls, 'aria-label': label, title: label, on: { click: onClick } }, [svgIcon(ICON[icon])]);
    return b;
  }

  function formatBytes(n) {
    if (n < 1024) { return n + ' B'; }
    if (n < 1024 * 1024) { return Math.max(1, Math.round(n / 1024)) + ' KB'; }
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  function httpUrl(value) {
    var u = String(value == null ? '' : value).trim();
    if (!/^https?:\/\/[^\s<>"'`\\]+$/i.test(u)) { return ''; }
    try { return /^https?:$/.test(new URL(u).protocol) ? u : ''; } catch (e) { return ''; }
  }

  function link(url, text) {
    return el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: text || url });
  }

  function valueText(v) {
    if (v == null) { return ''; }
    if (typeof v === 'string') { return v; }
    if (typeof v === 'number' || typeof v === 'boolean') { return String(v); }
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }

  function fieldLabel(name) {
    if (Object.prototype.hasOwnProperty.call(FIELD_LABELS, name)) { return FIELD_LABELS[name]; }
    var s = String(name).replace(/_/g, ' ');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function reducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }
  function isPhone() {
    try { return window.matchMedia('(max-width: 640px)').matches; } catch (e) { return false; }
  }

  /* ---------- persistence (text only) ---------- */

  function save() {
    try {
      window.sessionStorage.setItem(STORE_KEY, JSON.stringify({
        v: 1, user: state.user, open: state.open, draft: state.draft,
        messages: state.messages.map(function (m) {
          return { role: m.role, text: m.text, files: m.files, failed: m.failed, proposals: m.proposals, note: m.note, skipped: m.skipped };
        })
      }));
    } catch (e) { /* storage full or unavailable: the conversation just won't survive navigation */ }
  }

  function forget() { try { window.sessionStorage.removeItem(STORE_KEY); } catch (e) { /* ignore */ } }

  function restore() {
    var raw = null;
    try { raw = window.sessionStorage.getItem(STORE_KEY); } catch (e) { return; }
    if (!raw) { return; }
    try {
      var d = JSON.parse(raw);
      if (!d || d.v !== 1 || d.user !== state.user || !Array.isArray(d.messages)) { forget(); return; }
      state.open = !!d.open;
      state.draft = typeof d.draft === 'string' ? d.draft.slice(0, MAX_CHARS * 2) : '';
      state.messages = d.messages.filter(function (m) {
        return m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string';
      }).map(function (m) {
        seq += 1;
        return {
          id: seq, role: m.role, text: m.text,
          files: Array.isArray(m.files) ? m.files.map(String) : [],
          failed: m.failed && typeof m.failed === 'object' ? m.failed : null,
          proposals: cleanProposals(m.proposals, true),
          note: m.note && typeof m.note === 'object' ? m.note : null,
          skipped: m.skipped | 0
        };
      });
      /* A question that was still waiting when the page was left never got its answer. */
      var last = state.messages[state.messages.length - 1];
      if (last && last.role === 'user' && !last.failed) {
        last.failed = { kind: 'info', title: 'This request was interrupted', text: 'The page was left before the assistant answered.' };
      }
    } catch (e) { forget(); }
  }

  /* ---------- proposals: normalise what the server sent ---------- */

  function cleanProposals(list, fromStore) {
    if (!Array.isArray(list)) { return []; }
    var out = [];
    list.forEach(function (p) {
      if (!p || typeof p !== 'object') { return; }
      if (!Object.prototype.hasOwnProperty.call(ENTITIES, p.entity) || !Object.prototype.hasOwnProperty.call(ACTIONS, p.action)) { return; }
      if (p.id == null || p.id === '') { return; }
      var status = fromStore && (p.status === 'applied' || p.status === 'discarded') ? p.status : 'pending';
      out.push({
        id: p.id, entity: p.entity, action: p.action,
        target_id: p.target_id == null ? null : p.target_id,
        summary: typeof p.summary === 'string' ? p.summary : '',
        fields: p.fields && typeof p.fields === 'object' && !Array.isArray(p.fields) ? p.fields : {},
        before: p.before && typeof p.before === 'object' && !Array.isArray(p.before) ? p.before : null,
        status: status,
        rowId: fromStore && p.rowId != null ? p.rowId : null,
        error: null
      });
    });
    return out;
  }

  /* ---------- light markdown -> DOM (never innerHTML) ---------- */

  var INLINE = /(`[^`\n]+`)|(\*\*[^\n]+?\*\*)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>"'`]+)|(\*[^\s*](?:[^*\n]*[^\s*])?\*)/;

  function inline(parent, text) {
    var rest = String(text);
    while (rest) {
      var m = INLINE.exec(rest);
      if (!m) { parent.appendChild(document.createTextNode(rest)); return; }
      if (m.index) { parent.appendChild(document.createTextNode(rest.slice(0, m.index))); }
      var tok = m[0];
      var consumed = tok.length;
      if (m[1]) {
        parent.appendChild(el('code', { text: tok.slice(1, -1) }));
      } else if (m[2]) {
        var strong = el('strong');
        inline(strong, tok.slice(2, -2));
        parent.appendChild(strong);
      } else if (m[3]) {
        var parts = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/.exec(tok);
        var href = parts ? httpUrl(parts[2]) : '';
        if (href) { parent.appendChild(link(href, parts[1])); }
        else { parent.appendChild(document.createTextNode(tok)); }
      } else if (m[5]) {
        var em = el('em');
        inline(em, tok.slice(1, -1));
        parent.appendChild(em);
      } else {
        /* bare URL: keep trailing punctuation out of the link */
        var trail = /[.,;:!?)\]]+$/.exec(tok);
        var urlText = trail ? tok.slice(0, tok.length - trail[0].length) : tok;
        var safe = httpUrl(urlText);
        if (safe) { parent.appendChild(link(safe, urlText)); consumed = urlText.length; }
        else { parent.appendChild(document.createTextNode(tok)); }
      }
      rest = rest.slice(m.index + consumed);
    }
  }

  function markdown(text) {
    var root = el('div', { class: 'asst-md' });
    var lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    var para = [];
    var list = null;
    var listKind = '';

    function flushPara() {
      if (!para.length) { return; }
      var p = el('p');
      para.forEach(function (line, i) {
        if (i) { p.appendChild(el('br')); }
        inline(p, line);
      });
      root.appendChild(p);
      para = [];
    }
    function flushList() { list = null; listKind = ''; }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var fence = /^\s*```/.test(line);
      if (fence) {
        flushPara(); flushList();
        var code = [];
        i += 1;
        while (i < lines.length && !/^\s*```/.test(lines[i])) { code.push(lines[i]); i += 1; }
        root.appendChild(el('pre', {}, [el('code', { text: code.join('\n') })]));
        continue;
      }
      if (!line.trim()) { flushPara(); flushList(); continue; }
      var bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
      var numbered = /^\s*\d{1,3}[.)]\s+(.*)$/.exec(line);
      var heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
      if (bullet || numbered) {
        flushPara();
        var kind = bullet ? 'ul' : 'ol';
        if (!list || listKind !== kind) { list = el(kind); listKind = kind; root.appendChild(list); }
        var li = el('li');
        inline(li, (bullet || numbered)[1]);
        list.appendChild(li);
      } else if (heading) {
        flushPara(); flushList();
        var h = el('p', { class: 'asst-md-heading' });
        inline(h, heading[1]);
        root.appendChild(h);
      } else {
        flushList();
        para.push(line);
      }
    }
    flushPara();
    return root;
  }

  /* ---------- attachments ---------- */

  function mediaType(file) {
    var t = String(file.type || '').toLowerCase();
    if (t === 'image/jpg') { t = 'image/jpeg'; }
    if (TYPES.indexOf(t) !== -1) { return t; }
    if (!t) {
      var ext = /\.([a-z0-9]+)$/i.exec(file.name || '');
      if (ext && Object.prototype.hasOwnProperty.call(EXT_TYPES, ext[1].toLowerCase())) { return EXT_TYPES[ext[1].toLowerCase()]; }
    }
    return '';
  }

  function totalBytes() { return attachments.reduce(function (n, a) { return n + a.size; }, 0); }

  function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) { return; }
    var problems = [];
    var room = MAX_FILES - attachments.length - reading;
    var bytes = totalBytes();

    files.forEach(function (file) {
      var name = file.name || 'pasted-file';
      var type = mediaType(file);
      if (!type) { problems.push('“' + name + '” can’t be attached — only PDF, PNG, JPEG, WebP, GIF and plain-text files.'); return; }
      if (!file.size) { problems.push('“' + name + '” is empty.'); return; }
      if (room <= 0) { problems.push('“' + name + '” was not added — at most ' + MAX_FILES + ' files per message.'); return; }
      if (bytes + file.size > MAX_TOTAL_BYTES) {
        problems.push('“' + name + '” (' + formatBytes(file.size) + ') was not added — attachments can total at most ' + formatBytes(MAX_TOTAL_BYTES) + '.');
        return;
      }
      room -= 1;
      bytes += file.size;
      reading += 1;
      var reader = new FileReader();
      reader.onload = function () {
        reading -= 1;
        var url = String(reader.result || '');
        var comma = url.indexOf(',');
        if (comma === -1) { notice('“' + name + '” could not be read.'); syncComposer(); return; }
        attachments.push({
          name: name.slice(0, 200), media_type: type, size: file.size,
          data: url.slice(comma + 1),
          preview: type.indexOf('image/') === 0 ? 'data:' + type + ';base64,' + url.slice(comma + 1) : ''
        });
        renderChips();
        syncComposer();
      };
      reader.onerror = function () {
        reading -= 1;
        notice('“' + name + '” could not be read.');
        syncComposer();
      };
      reader.readAsDataURL(file);
    });
    notice(problems.join(' '));
    syncComposer();
  }

  function renderChips() {
    clear(ui.chips);
    ui.chips.hidden = !attachments.length;
    attachments.forEach(function (a, index) {
      var thumb = a.preview
        ? el('img', { class: 'asst-chip-thumb', src: a.preview, alt: '' })
        : el('span', { class: 'asst-chip-thumb asst-chip-thumb--file' }, [svgIcon(ICON.file)]);
      var remove = iconButton('x', 'Remove ' + a.name, 'asst-chip-remove', function () {
        attachments.splice(index, 1);
        notice('');
        renderChips();
        syncComposer();
        var next = ui.chips.querySelectorAll('.asst-chip-remove')[Math.min(index, attachments.length - 1)];
        (next || ui.input).focus();
      });
      ui.chips.appendChild(el('li', { class: 'asst-chip' }, [
        thumb,
        el('span', { class: 'asst-chip-text' }, [
          el('span', { class: 'asst-chip-name', text: a.name }),
          el('span', { class: 'asst-chip-size', text: formatBytes(a.size) })
        ]),
        remove
      ]));
    });
  }

  /* ---------- composer ---------- */

  function notice(text) {
    ui.notice.textContent = text || '';
    ui.notice.hidden = !text;
  }

  function liveMessages() { return state.messages.filter(function (m) { return !m.failed; }); }

  function autosize() {
    /* CSSOM height only (allowed by the CSP; there are no style attributes in markup). */
    ui.input.style.height = 'auto';
    ui.input.style.height = Math.min(ui.input.scrollHeight + 2, 168) + 'px';
  }

  function syncComposer() {
    var len = ui.input.value.length;
    var full = liveMessages().length >= MAX_MESSAGES - 1 && !busy;
    var over = len > MAX_CHARS;
    ui.count.hidden = len < MAX_CHARS - 500;
    ui.count.textContent = len + ' / ' + MAX_CHARS;
    ui.count.classList.toggle('is-over', over);
    ui.limit.hidden = !full;
    ui.send.disabled = busy || reading > 0 || over || full || (!ui.input.value.trim() && !attachments.length);
    ui.attach.disabled = full;
    ui.send.setAttribute('aria-label', busy ? 'Waiting for the assistant' : 'Send');
    ui.send.title = busy ? 'Waiting for the assistant' : 'Send';
  }

  function submit() {
    if (busy || reading > 0) { return; }
    var text = ui.input.value.trim();
    if (!text && !attachments.length) { return; }
    if (text.length > MAX_CHARS) {
      notice('This message is too long (' + text.length + ' characters; the limit is ' + MAX_CHARS + '). Shorten it, or attach long text as a .txt file.');
      return;
    }
    if (liveMessages().length >= MAX_MESSAGES - 1) { syncComposer(); return; }

    seq += 1;
    var msg = { id: seq, role: 'user', text: text || NO_TEXT, files: attachments.map(function (a) { return a.name; }), failed: null, proposals: [], note: null, skipped: 0 };
    if (attachments.length) { sentFiles[msg.id] = attachments; }
    attachments = [];
    state.messages.push(msg);
    state.draft = '';
    ui.input.value = '';
    notice('');
    renderChips();
    autosize();
    ask(msg);
  }

  /* ---------- talking to the API ---------- */

  function wireText(m) {
    var text = m.text;
    if (m.role === 'assistant' && SEND_PROPOSAL_CONTEXT && m.proposals.length) {
      var lines = m.proposals.map(function (p) {
        var status = p.status === 'applied' ? 'applied' + (p.rowId != null ? ' (row ' + p.rowId + ')' : '')
          : p.status === 'discarded' ? 'discarded by the admin' : 'not applied yet';
        var fields = '';
        try { fields = JSON.stringify(p.fields); } catch (e) { fields = ''; }
        return '- ' + p.id + ': ' + p.action + ' ' + p.entity + (p.target_id != null ? ' #' + p.target_id : '') +
          ' — ' + status + (fields && fields.length <= 1500 ? ' — fields ' + fields : '');
      });
      text += (text ? '\n\n' : '') + '[Proposals shown to the admin:\n' + lines.join('\n') + ']';
    }
    if (!text) { text = '(no text)'; }
    return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS - 1) + '…' : text;
  }

  var FAILURES = {
    400: ['error', 'The request was not accepted'],
    413: ['error', 'That was too much to send'],
    422: ['info', 'The assistant declined this request'],
    429: ['info', 'Daily limit reached'],
    502: ['error', 'The assistant service had a problem'],
    503: ['info', 'The assistant isn’t set up yet']
  };
  var FAILURE_TEXT = {
    400: 'Check the message and attachments, then try again.',
    413: 'Remove or shrink the attachments (for example, attach only the relevant pages) and try again.',
    422: 'Try rephrasing what you need.',
    429: 'The assistant has been used as much as it can be today. Try again tomorrow — the forms on this page still work.',
    502: 'Nothing was changed. Please try again in a moment.',
    503: 'It hasn’t been configured on the server. Nothing is wrong with the site — you can keep using the forms on this page.'
  };

  function failureFor(r) {
    var code = r.data && typeof r.data.error === 'string' ? r.data.error : '';
    var message = r.data && typeof r.data.message === 'string' ? r.data.message : '';
    var status = r.status;
    if (code === 'assistant_not_configured') { status = 503; }
    else if (code === 'assistant_refused') { status = 422; }
    else if (code === 'assistant_upstream_error') { status = 502; }
    if (code === 'assistant_busy') {
      return { kind: 'info', title: 'The assistant is busy', text: 'It is handling other requests right now. Nothing was changed; please try again in a moment.', status: status };
    }
    if (code === 'assistant_blocked_by_gateway_policy') {
      return { kind: 'info', title: 'Blocked by the AI service policy', text: message || 'The AI service refused this content. Try removing personal details from the message or attachment.', status: status };
    }
    var known = FAILURES[status];
    if (known) {
      /* For "not set up" the calm explanation is better than a raw server string. */
      return { kind: known[0], title: known[1], text: status === 503 ? FAILURE_TEXT[503] : (message || FAILURE_TEXT[status]), status: status };
    }
    return {
      kind: 'error', title: 'Something went wrong',
      text: message || ('The server answered with HTTP ' + status + '. Nothing was changed; please try again.'), status: status
    };
  }

  function ask(msg) {
    var files = sentFiles[msg.id] || [];
    /* everything that was actually exchanged, in order, ending with this message */
    var history = liveMessages().filter(function (m) { return m !== msg; });
    var body = {
      messages: history.concat([msg]).map(function (m) { return { role: m.role, text: wireText(m) }; }),
      attachments: files.map(function (a) { return { name: a.name, media_type: a.media_type, data: a.data }; })
    };

    busy = true;
    abortCtl = window.AbortController ? new AbortController() : null;
    waitStart = Date.now();
    save();
    startWaiting();
    render(true);
    syncComposer();

    function settle() {
      busy = false;
      abortCtl = null;
      stopWaiting();
    }

    A.request('POST', '/api/assistant', body, true, { timeout: ASK_TIMEOUT_MS, signal: abortCtl ? abortCtl.signal : undefined })
      .then(function (r) {
        if (r.status === 401) {
          /* Keep the question so it can be sent again after signing in. */
          msg.failed = { kind: 'info', title: 'This request was interrupted', text: 'Your session expired before the assistant answered.' };
          save();
          A.sessionExpired(null);
          return;
        }
        settle();
        if (!r.ok || !r.data || typeof r.data !== 'object') {
          msg.failed = r.ok
            ? { kind: 'error', title: 'Unexpected answer from the server', text: 'Nothing was changed. Please try again.' }
            : failureFor(r);
          finish(msg.failed.title + '. ' + msg.failed.text);
          return;
        }
        delete sentFiles[msg.id];
        var raw = Array.isArray(r.data.proposals) ? r.data.proposals : [];
        var proposals = cleanProposals(raw, false);
        seq += 1;
        var reply = {
          id: seq, role: 'assistant', text: typeof r.data.reply === 'string' ? r.data.reply : '',
          files: [], failed: null, proposals: proposals, note: null, skipped: raw.length - proposals.length
        };
        if (!reply.text && !proposals.length) { reply.text = 'The assistant sent an empty answer. Try asking again.'; }
        state.messages.push(reply);
        if (!state.open) { unread = true; }
        finish('Assistant: ' + reply.text.slice(0, 400) + (proposals.length ? ' ' + plural(proposals.length, 'proposed change') + ' to review.' : ''));
      }, function (err) {
        settle();
        if (err && err.aborted) {
          msg.failed = { kind: 'info', title: 'Cancelled', text: 'The request was stopped. If the assistant had already started, nothing was changed.' };
        } else if (err && err.timeout) {
          msg.failed = { kind: 'error', title: 'The assistant took too long', text: 'No answer arrived in time. Nothing was changed; try again, perhaps with a smaller request.' };
        } else {
          msg.failed = { kind: 'error', title: 'Couldn’t reach the server', text: 'Check your connection and try again. Nothing was changed.' };
        }
        finish(msg.failed.title + '. ' + msg.failed.text);
      });

    function finish(announcement) {
      save();
      render(true);
      syncComposer();
      syncLauncher();
      announce(announcement);
    }
  }

  function retry(msg) {
    if (busy) { return; }
    var index = state.messages.indexOf(msg);
    if (index === -1) { return; }
    if (liveMessages().length >= MAX_MESSAGES - 1) { syncComposer(); return; }
    state.messages.splice(index, 1);
    msg.failed = null;
    state.messages.push(msg);
    ask(msg);
  }

  /* Put a failed message back into the box (its attachments too, if still in memory). */
  function editAgain(msg) {
    var index = state.messages.indexOf(msg);
    if (index !== -1) { state.messages.splice(index, 1); }
    var files = sentFiles[msg.id];
    delete sentFiles[msg.id];
    if (files && !attachments.length) { attachments = files; renderChips(); }
    ui.input.value = msg.text === NO_TEXT ? '' : msg.text;
    state.draft = ui.input.value;
    save();
    render(false);
    autosize();
    syncComposer();
    ui.input.focus();
  }

  /* ---------- waiting state ---------- */

  function waitLabel(seconds) {
    if (seconds < 8) { return 'Working on it…'; }
    if (seconds < 30) { return 'Still working — reading links and files takes a little while.'; }
    if (seconds < 90) { return 'Still working. Longer requests can take a minute or two.'; }
    return 'Still working — this is a long one. You can keep waiting or cancel.';
  }
  function clock(seconds) {
    var s = seconds % 60;
    return Math.floor(seconds / 60) + ':' + (s < 10 ? '0' : '') + s;
  }
  function tickWaiting() {
    if (!ui.waitText) { return; }
    var seconds = Math.max(0, Math.floor((Date.now() - waitStart) / 1000));
    var label = waitLabel(seconds);
    if (ui.waitText.textContent !== label) { ui.waitText.textContent = label; }
    ui.waitClock.textContent = clock(seconds);
  }
  function startWaiting() {
    stopWaiting();
    waitTimer = setInterval(tickWaiting, 1000);
    syncLauncher();
  }
  function stopWaiting() {
    if (waitTimer) { clearInterval(waitTimer); waitTimer = null; }
    ui.waitText = null; ui.waitClock = null;
    syncLauncher();
  }

  /* ---------- applying proposals ---------- */

  function pending(msg) { return msg.proposals.filter(function (p) { return p.status === 'pending'; }); }

  function applyProposals(msg, list) {
    if (applying || !list.length) { return; }
    var deletes = list.filter(function (p) { return p.action === 'delete'; });
    var confirmed = Promise.resolve(true);
    if (deletes.length) {
      confirmed = A.confirmDialog({
        title: list.length === 1 ? 'Delete this ' + ENTITIES[list[0].entity].label.toLowerCase() + '?'
          : 'Apply ' + plural(list.length, 'change') + ', including ' + plural(deletes.length, 'deletion') + '?',
        text: 'Deleting cannot be undone.',
        items: deletes.map(function (p) { return (p.target_id != null ? '#' + p.target_id + ' ' : '') + describe(p); }),
        okLabel: list.length === 1 ? 'Delete' : 'Apply all', danger: true
      });
    }
    confirmed.then(function (yes) {
      if (!yes || applying) { return; }
      applying = true;
      msg.note = null;
      list.forEach(function (p) { p.status = 'applying'; p.error = null; });
      render(false);

      function fail(text, namedIn) {
        applying = false;
        list.forEach(function (p) {
          if (p.status !== 'applying') { return; }
          p.status = 'pending';
          /* the server names the failing proposal id in its message */
          if (namedIn && new RegExp('(^|[^A-Za-z0-9_])' + String(p.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^A-Za-z0-9_]|$)').test(namedIn)) { p.error = true; }
        });
        msg.note = { kind: 'error', text: text };
        save();
        render(false);
        announce(text);
      }

      A.request('POST', '/api/assistant/apply', {
        proposals: list.map(function (p) { return { id: p.id, entity: p.entity, action: p.action, target_id: p.target_id, fields: p.fields }; })
      }, true, { timeout: APPLY_TIMEOUT_MS }).then(function (r) {
        if (r.status === 401) { list.forEach(function (p) { p.status = 'pending'; }); save(); A.sessionExpired(null); return; }
        var message = r.data && typeof r.data.message === 'string' ? r.data.message : '';
        if (!r.ok) {
          if (r.status === 400) { fail('Nothing was applied. ' + (message || 'The server rejected one of the changes.'), message); }
          else if (r.status === 429) { fail(message || 'Too many requests. Nothing was applied; please wait a moment and try again.'); }
          else { fail((message ? message + ' ' : 'The server had a problem (HTTP ' + r.status + '). ') + 'Nothing was applied; please try again.'); }
          return;
        }
        var results = r.data && Array.isArray(r.data.results) ? r.data.results : null;
        if (!results) { fail('The server’s answer could not be read. Reload the page to see what was saved.'); return; }
        var done = [];
        var failed = [];
        list.forEach(function (p) {
          var res = results.filter(function (x) { return x && String(x.id) === String(p.id); })[0];
          if (res && res.ok) { p.status = 'applied'; p.rowId = res.row_id == null ? null : res.row_id; done.push(p); }
          else { p.status = 'pending'; p.error = true; failed.push(String((res && (res.message || res.error)) || 'not confirmed by the server')); }
        });
        applying = false;
        msg.note = afterApply(done, failed);
        save();
        render(false);
        announce(msg.note.text);
      }, function (err) {
        fail(err && err.timeout
          ? 'The server did not answer in time. Reload the page to check whether the change was saved before trying again.'
          : 'Couldn’t reach the server. Nothing was applied; check your connection and try again.');
      });
    });
  }

  /* Refresh what this page shows, and say where the change can be seen. */
  function afterApply(done, failedMessages) {
    var refreshed = false;
    var needsReload = false;
    var elsewhere = [];
    var seen = {};
    done.forEach(function (p) {
      var info = ENTITIES[p.entity];
      if (seen[p.entity]) { return; }
      seen[p.entity] = true;
      if (info.page === page) {
        var ok = false;
        try { ok = A.reload(info.key); } catch (e) { ok = false; }
        if (ok) { refreshed = true; } else { needsReload = true; }
      } else if (elsewhere.filter(function (x) { return x.href === info.href; }).length === 0) {
        elsewhere.push({ href: info.href, label: info.pageLabel });
      }
    });
    var text = done.length ? 'Applied ' + plural(done.length, 'change') + '.' : '';
    if (refreshed) { text += ' The list on this page was refreshed.'; }
    if (needsReload) { text += ' Reload the page to see it here (unsaved form input will be lost).'; }
    if (failedMessages.length) { text += (text ? ' ' : '') + plural(failedMessages.length, 'change') + ' failed: ' + failedMessages.join('; ') + '.'; }
    return { kind: failedMessages.length ? 'error' : 'ok', text: text.trim(), reload: needsReload, links: elsewhere };
  }

  function describe(p) {
    var src = p.action === 'delete' ? (p.before || p.fields) : Object.assign({}, p.before || {}, p.fields);
    return valueText(src.title || src.name || p.summary || '').slice(0, 160);
  }

  /* ---------- rendering ---------- */

  function valueNode(value, cls) {
    var text = valueText(value);
    var node = el('span', { class: 'asst-val' + (cls ? ' ' + cls : '') });
    if (text === '') { node.classList.add('is-empty'); node.textContent = '(empty)'; return node; }
    var url = httpUrl(text);
    if (url) { node.appendChild(link(url, text)); return node; }
    if (text.length <= LONG_VALUE) { node.textContent = text; return node; }
    var body = el('span', { text: text.slice(0, LONG_VALUE) + '…' });
    var more = el('button', { type: 'button', class: 'asst-more', text: 'Show all', 'aria-expanded': 'false' });
    more.addEventListener('click', function () {
      var open = more.getAttribute('aria-expanded') === 'true';
      body.textContent = open ? text.slice(0, LONG_VALUE) + '…' : text;
      more.textContent = open ? 'Show all' : 'Show less';
      more.setAttribute('aria-expanded', open ? 'false' : 'true');
    });
    node.appendChild(body);
    node.appendChild(document.createTextNode(' '));
    node.appendChild(more);
    return node;
  }

  function fieldRows(p) {
    var rows = [];
    function row(name, children) {
      rows.push(el('div', { class: 'asst-field' }, [el('dt', { text: fieldLabel(name) })].concat([el('dd', {}, children)])));
    }
    var names;
    if (p.action === 'delete') {
      var gone = p.before || p.fields;
      names = Object.keys(gone).filter(function (k) { return k !== 'id' && valueText(gone[k]) !== ''; });
      names.forEach(function (k) { row(k, [valueNode(gone[k], 'asst-val--gone')]); });
    } else if (p.action === 'update' && p.before) {
      names = Object.keys(p.fields).filter(function (k) { return k !== 'id' && valueText(p.fields[k]) !== valueText(p.before[k]); });
      names.forEach(function (k) {
        row(k, [
          el('span', { class: 'sr-only', text: 'Before: ' }),
          valueNode(p.before[k], 'asst-val--before'),
          el('span', { class: 'asst-arrow', 'aria-hidden': 'true', text: '→' }),
          el('span', { class: 'sr-only', text: 'After: ' }),
          valueNode(p.fields[k], 'asst-val--after')
        ]);
      });
    } else {
      names = Object.keys(p.fields).filter(function (k) { return k !== 'id' && (p.action === 'update' || valueText(p.fields[k]) !== ''); });
      names.forEach(function (k) { row(k, [valueNode(p.fields[k], p.action === 'update' ? 'asst-val--after' : '')]); });
    }
    return rows;
  }

  function proposalCard(msg, p) {
    var info = ENTITIES[p.entity];
    var key = 'p' + msg.id + ':' + p.id;
    var settled = p.status === 'applied' || p.status === 'discarded';
    var rows = fieldRows(p);
    var head = el('div', { class: 'asst-card-head' }, [
      el('span', { class: 'asst-tag asst-tag--' + p.action, text: ACTIONS[p.action] }),
      el('span', { class: 'asst-card-entity', text: info.label + (p.target_id != null ? ' #' + p.target_id : '') }),
      p.status === 'applied' ? el('span', { class: 'asst-status asst-status--ok' }, [svgIcon(ICON.check), p.action === 'delete' ? 'Deleted' : 'Applied']) : null,
      p.status === 'discarded' ? el('span', { class: 'asst-status', text: 'Discarded' }) : null
    ]);

    var body;
    if (rows.length) { body = el('dl', { class: 'asst-fields' }, rows); }
    else if (p.action === 'update') { body = el('p', { class: 'asst-card-empty', text: 'No field differs from the current record.' }); }
    else { body = null; }

    var actions = null;
    if (!settled) {
      var working = p.status === 'applying';
      var applyLabel = p.action === 'delete' ? 'Delete' : 'Apply';
      actions = el('div', { class: 'asst-card-actions' }, [
        el('button', {
          type: 'button', class: 'btn btn--small ' + (p.action === 'delete' ? 'btn--danger' : 'btn--solid'), 'data-key': key + ':apply',
          text: working ? (p.action === 'delete' ? 'Deleting…' : 'Applying…') : applyLabel, disabled: applying,
          'aria-label': applyLabel + ': ' + (p.summary || describe(p)),
          on: { click: function () { applyProposals(msg, [p]); } }
        }),
        el('button', {
          type: 'button', class: 'btn btn--small btn--outline', 'data-key': key + ':discard', text: 'Discard', disabled: applying,
          'aria-label': 'Discard: ' + (p.summary || describe(p)),
          on: { click: function () { p.status = 'discarded'; p.error = null; msg.note = null; save(); render(false); } }
        })
      ]);
    }

    return el('li', {
      class: 'asst-card asst-card--' + p.action + (settled ? ' is-' + p.status : '') + (p.error ? ' has-error' : '')
    }, [
      head,
      p.summary ? el('p', { class: 'asst-card-summary', text: p.summary }) : null,
      settled && p.status === 'discarded' ? null : body,
      p.status === 'applied' && p.rowId != null && p.action === 'add' ? el('p', { class: 'asst-card-meta', text: 'Saved as #' + p.rowId }) : null,
      actions
    ]);
  }

  function noteBlock(msg) {
    var n = msg.note;
    if (!n || !n.text) { return null; }
    var extras = [];
    (Array.isArray(n.links) ? n.links : []).forEach(function (l) {
      if (l && /^admin[\w]*\.html$/.test(String(l.href))) { extras.push(el('a', { class: 'asst-note-link', href: l.href, text: 'Open ' + l.label + ' →' })); }
    });
    if (n.reload) {
      extras.push(el('button', { type: 'button', class: 'btn btn--small btn--outline', text: 'Reload page', 'data-key': 'n' + msg.id + ':reload', on: { click: function () { window.location.reload(); } } }));
    }
    return el('div', { class: 'asst-note asst-note--' + (n.kind === 'error' ? 'error' : 'ok'), role: n.kind === 'error' ? 'alert' : null }, [
      el('span', { text: n.text }),
      extras.length ? el('span', { class: 'asst-note-actions' }, extras) : null
    ]);
  }

  function messageNode(msg) {
    var nodes = [];
    if (msg.role === 'user') {
      var bubble = el('div', { class: 'asst-bubble asst-bubble--user' + (msg.failed ? ' is-failed' : '') }, [
        el('span', { class: 'sr-only', text: 'You: ' }),
        el('p', { class: 'asst-plain', text: msg.text }),
        msg.files.length ? el('ul', { class: 'asst-sent-files', 'aria-label': 'Attached files' }, msg.files.map(function (name) {
          return el('li', {}, [svgIcon(ICON.file), el('span', { text: name })]);
        })) : null
      ]);
      nodes.push(el('div', { class: 'asst-row asst-row--user' }, [bubble]));
      if (msg.failed) {
        var hasFiles = msg.files.length > 0;
        var lost = hasFiles && !sentFiles[msg.id];
        var soft = msg.failed.kind === 'info';
        nodes.push(el('div', { class: 'asst-alert asst-alert--' + (soft ? 'info' : 'error') }, [
          svgIcon(soft ? ICON.info : ICON.warn),
          el('div', { class: 'asst-alert-body' }, [
            el('p', { class: 'asst-alert-title', text: String(msg.failed.title || 'Not sent') }),
            el('p', { class: 'asst-alert-text', text: String(msg.failed.text || '') + (lost ? ' The attachments need to be added again.' : '') }),
            el('div', { class: 'asst-alert-actions' }, [
              lost ? null : el('button', { type: 'button', class: 'btn btn--small btn--outline', text: 'Try again', 'data-key': 'm' + msg.id + ':retry', disabled: busy, on: { click: function () { retry(msg); } } }),
              el('button', { type: 'button', class: 'btn btn--small btn--outline', text: 'Edit message', 'data-key': 'm' + msg.id + ':edit', disabled: busy, on: { click: function () { editAgain(msg); } } })
            ])
          ])
        ]));
      }
      return nodes;
    }

    if (msg.text) {
      nodes.push(el('div', { class: 'asst-row asst-row--assistant' }, [
        el('div', { class: 'asst-bubble asst-bubble--assistant' }, [el('span', { class: 'sr-only', text: 'Assistant: ' }), markdown(msg.text)])
      ]));
    }
    if (msg.proposals.length) {
      var open = pending(msg);
      var group = el('div', { class: 'asst-proposals' }, [
        el('div', { class: 'asst-proposals-head' }, [
          el('span', { class: 'asst-proposals-title', text: msg.proposals.length === 1 ? 'Proposed change' : msg.proposals.length + ' proposed changes' }),
          msg.proposals.length > 1 && open.length > 1 ? el('button', {
            type: 'button', class: 'btn btn--small btn--solid', text: 'Apply all ' + open.length, 'data-key': 'g' + msg.id + ':all', disabled: applying,
            on: { click: function () { applyProposals(msg, pending(msg)); } }
          }) : null
        ]),
        el('ul', { class: 'asst-cards' }, msg.proposals.map(function (p) { return proposalCard(msg, p); })),
        noteBlock(msg)
      ]);
      nodes.push(group);
    }
    if (msg.skipped > 0) {
      nodes.push(el('p', { class: 'asst-skipped', text: plural(msg.skipped, 'proposed change') + ' could not be shown because the format was not recognised.' }));
    }
    return nodes;
  }

  function emptyState() {
    return el('div', { class: 'asst-empty' }, [
      el('div', { class: 'asst-empty-icon' }, [svgIcon(ICON.chat)]),
      el('p', { class: 'asst-empty-title', text: 'What should change on the site?' }),
      el('p', { class: 'asst-empty-text', text: 'Describe it in your own words, in Korean or English — paste a paper link, or attach a PDF or screenshot. You review every change before it is saved.' }),
      el('ul', { class: 'asst-examples', 'aria-label': 'Example requests' }, EXAMPLES.map(function (ex) {
        return el('li', {}, [el('button', {
          type: 'button', class: 'asst-example', text: ex.label,
          on: { click: function () {
            ui.input.value = ex.text;
            state.draft = ex.text;
            save();
            autosize();
            syncComposer();
            notice(ex.attach ? 'Attach the file with the paperclip, or drop it here, then send.' : '');
            ui.input.focus();
            ui.input.setSelectionRange(ex.text.length, ex.text.length);
          } }
        })]);
      }))
    ]);
  }

  function waitingNode() {
    ui.waitText = el('span', { class: 'asst-wait-text' });
    ui.waitClock = el('span', { class: 'asst-wait-clock', 'aria-hidden': 'true' });
    var node = el('div', { class: 'asst-row asst-row--assistant' }, [
      el('div', { class: 'asst-bubble asst-bubble--assistant asst-wait' }, [
        el('span', { class: 'asst-dots', 'aria-hidden': 'true' }, [el('span'), el('span'), el('span')]),
        el('span', { class: 'asst-wait-body' }, [ui.waitText, ui.waitClock]),
        abortCtl ? el('button', { type: 'button', class: 'asst-cancel', text: 'Cancel', 'data-key': 'wait:cancel', on: { click: function () { if (abortCtl) { abortCtl.abort(); } } } }) : null
      ])
    ]);
    tickWaiting();
    return node;
  }

  function render(toBottom) {
    var active = document.activeElement;
    var hadFocus = active && ui.log.contains(active);
    var key = hadFocus ? active.getAttribute('data-key') : null;
    var top = ui.log.scrollTop;

    clear(ui.log);
    ui.waitText = null; ui.waitClock = null;
    if (!state.messages.length) {
      ui.log.appendChild(emptyState());
    } else {
      state.messages.forEach(function (msg) {
        messageNode(msg).forEach(function (n) { ui.log.appendChild(n); });
      });
      if (busy) { ui.log.appendChild(waitingNode()); }
    }
    ui.fresh.disabled = !state.messages.length && !ui.input.value && !attachments.length;

    if (toBottom) { ui.log.scrollTop = ui.log.scrollHeight; } else { ui.log.scrollTop = top; }

    if (hadFocus) {
      var again = null;
      if (key) {
        Array.prototype.forEach.call(ui.log.querySelectorAll('[data-key]'), function (b) {
          if (!again && !b.disabled && b.getAttribute('data-key') === key) { again = b; }
        });
      }
      (again || ui.input).focus({ preventScroll: true });
    }
  }

  function announce(text) {
    /* A separate polite live region: the log itself is re-rendered and would be re-read. */
    ui.live.textContent = '';
    window.setTimeout(function () { ui.live.textContent = String(text || '').slice(0, 600); }, 60);
  }

  function syncLauncher() {
    if (!ui.launcher) { return; }
    ui.launcher.classList.toggle('is-busy', busy);
    ui.launcher.classList.toggle('has-unread', unread && !busy);
    var label = 'Open the assistant' + (busy ? ' (working on your request)' : unread ? ' (new reply)' : '');
    ui.launcher.setAttribute('aria-label', label);
    ui.launcher.title = label;
  }

  /* ---------- open / close ---------- */

  function setOpen(open, moveFocus) {
    state.open = open;
    ui.panel.hidden = !open;
    ui.launcher.hidden = open;
    ui.launcher.setAttribute('aria-expanded', open ? 'true' : 'false');
    document.documentElement.classList.toggle('assistant-open', open);
    if (open) {
      unread = false;
      syncLauncher();
      autosize();
      ui.log.scrollTop = ui.log.scrollHeight;
      if (moveFocus) { ui.input.focus(); }
    } else if (moveFocus) {
      ui.launcher.focus();
    }
    save();
  }

  function newConversation() {
    var hasContent = state.messages.length > 0;
    var ask1 = hasContent
      ? A.confirmDialog({
        title: 'Start a new conversation?',
        text: busy ? 'The request in progress will be cancelled and this conversation cleared. Changes already applied stay saved.'
          : 'This conversation will be cleared. Changes already applied stay saved; proposals not applied yet are dropped.',
        okLabel: 'Start new'
      })
      : Promise.resolve(true);
    ask1.then(function (yes) {
      if (!yes) { return; }
      if (abortCtl) { abortCtl.abort(); }
      /* the aborted request settles asynchronously and marks its message; clear after that */
      window.setTimeout(function () {
        state.messages = [];
        state.draft = '';
        sentFiles = {};
        attachments = [];
        ui.input.value = '';
        notice('');
        renderChips();
        autosize();
        save();
        render(true);
        syncComposer();
        ui.input.focus();
      }, 0);
    });
  }

  /* ---------- build ---------- */

  function build() {
    ui.launcher = el('button', { type: 'button', class: 'asst-launcher', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': 'asst-panel' }, [
      svgIcon(ICON.chat), el('span', { class: 'asst-launcher-dot', 'aria-hidden': 'true' })
    ]);
    ui.launcher.addEventListener('click', function () { setOpen(true, true); });

    ui.fresh = iconButton('fresh', 'New conversation', 'asst-head-btn', newConversation);
    ui.close = iconButton('close', 'Minimise the assistant', 'asst-head-btn', function () { setOpen(false, true); });
    ui.log = el('div', { class: 'asst-log', role: 'log', 'aria-label': 'Conversation', 'aria-live': 'off', tabindex: '-1' });
    ui.live = el('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
    ui.chips = el('ul', { class: 'asst-chips', 'aria-label': 'Files to send', hidden: true });
    ui.notice = el('p', { class: 'asst-notice', role: 'alert', hidden: true });
    ui.limit = el('div', { class: 'asst-limit', hidden: true }, [
      el('span', { text: 'This conversation has reached its length limit (' + MAX_MESSAGES + ' messages).' }),
      el('button', { type: 'button', class: 'btn btn--small btn--outline', text: 'New conversation', on: { click: newConversation } })
    ]);
    ui.file = el('input', { type: 'file', class: 'sr-only', multiple: true, accept: ACCEPT, tabindex: '-1', 'aria-hidden': 'true' });
    ui.attach = iconButton('clip', 'Attach files (PDF, images or text)', 'asst-tool', function () { ui.file.click(); });
    ui.input = el('textarea', {
      class: 'asst-input', rows: '1', placeholder: 'Describe a change…', 'aria-label': 'Message to the assistant',
      autocomplete: 'off', enterkeyhint: 'send'
    });
    ui.send = iconButton('send', 'Send', 'asst-send', submit);
    ui.count = el('span', { class: 'asst-count', hidden: true });
    ui.drop = el('div', { class: 'asst-drop', hidden: true, 'aria-hidden': 'true' }, [
      el('div', { class: 'asst-drop-inner' }, [svgIcon(ICON.clip), el('span', { text: 'Drop files to attach' })])
    ]);

    ui.panel = el('section', { id: 'asst-panel', class: 'asst-panel', role: 'dialog', 'aria-label': 'Site assistant', hidden: true }, [
      el('header', { class: 'asst-head' }, [
        el('div', { class: 'asst-head-text' }, [
          el('h2', { class: 'asst-title', text: 'Assistant' }),
          el('p', { class: 'asst-sub', text: 'Nothing is saved until you press Apply.' })
        ]),
        ui.fresh, ui.close
      ]),
      ui.log,
      el('div', { class: 'asst-composer' }, [
        ui.limit,
        ui.chips,
        ui.notice,
        el('div', { class: 'asst-box' }, [ui.attach, ui.input, ui.send]),
        el('div', { class: 'asst-foot' }, [
          el('span', { class: 'asst-hint', text: 'Enter to send · Shift+Enter for a new line' }),
          ui.count
        ]),
        ui.file
      ]),
      ui.drop,
      ui.live
    ]);

    /* --- composer events --- */
    ui.input.addEventListener('input', function () {
      state.draft = ui.input.value;
      if (!ui.notice.hidden) { notice(''); }
      autosize();
      syncComposer();
      ui.fresh.disabled = !state.messages.length && !ui.input.value && !attachments.length;
      save();
    });
    ui.input.addEventListener('keydown', function (e) {
      /* Never send while an IME composition (Korean) is active; keyCode 229 covers Safari,
         where the Enter that commits a composition reports isComposing === false. */
      if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) { return; }
      if (e.isComposing || e.keyCode === 229) { return; }
      e.preventDefault();
      submit();
    });
    ui.input.addEventListener('paste', function (e) {
      var cd = e.clipboardData;
      if (!cd || !cd.files || !cd.files.length) { return; }
      /* Copying from an office document carries both text and a picture of it: prefer the text. */
      var text = '';
      try { text = cd.getData('text/plain'); } catch (err) { text = ''; }
      if (text && text.trim()) { return; }
      e.preventDefault();
      addFiles(cd.files);
    });
    ui.file.addEventListener('change', function () {
      addFiles(ui.file.files);
      ui.file.value = '';
      ui.input.focus();
    });

    /* --- drag and drop onto the panel --- */
    var dragDepth = 0;
    function hasFiles(e) {
      var types = e.dataTransfer && e.dataTransfer.types;
      return !!types && Array.prototype.indexOf.call(types, 'Files') !== -1;
    }
    function dropOff() { dragDepth = 0; ui.drop.hidden = true; }
    ui.panel.addEventListener('dragenter', function (e) {
      if (!hasFiles(e)) { return; }
      e.preventDefault();
      dragDepth += 1;
      ui.drop.hidden = false;
    });
    ui.panel.addEventListener('dragover', function (e) {
      if (!hasFiles(e)) { return; }
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    ui.panel.addEventListener('dragleave', function (e) {
      if (!hasFiles(e)) { return; }
      dragDepth -= 1;
      if (dragDepth <= 0) { dropOff(); }
    });
    ui.panel.addEventListener('drop', function (e) {
      if (!hasFiles(e)) { return; }
      e.preventDefault();
      dropOff();
      addFiles(e.dataTransfer.files);
      ui.input.focus();
    });

    /* --- keyboard: Escape closes; on phones (full screen) Tab stays inside the panel --- */
    document.addEventListener('keydown', function (e) {
      if (!state.open) { return; }
      if (document.querySelector('dialog[open]')) { return; }   /* a confirm dialog is on top */
      if (e.key === 'Escape' && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        setOpen(false, true);
        return;
      }
      if (e.key === 'Tab' && isPhone()) {
        var items = Array.prototype.filter.call(
          ui.panel.querySelectorAll('button, a[href], textarea'),
          function (n) { return !n.disabled && n.offsetParent !== null; }
        );
        if (!items.length) { return; }
        var first = items[0], last = items[items.length - 1];
        if (!ui.panel.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
        else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });

    document.body.appendChild(ui.launcher);
    document.body.appendChild(ui.panel);
    document.body.classList.add('has-assistant');
    if (reducedMotion()) { ui.panel.classList.add('no-motion'); }
  }

  function start() {
    if (started) { return; }
    started = true;
    state.user = String(A.user || '');
    restore();
    build();
    ui.input.value = state.draft;
    render(true);
    renderChips();
    syncComposer();
    syncLauncher();
    /* Reopen without stealing focus when the panel was open on the previous admin page
       (on phones it would cover the whole page, so it stays minimised there). */
    setOpen(state.open && !isPhone(), false);
  }

  document.addEventListener('dislab-admin-logout', function () {
    if (abortCtl) { abortCtl.abort(); }
    state.messages = []; state.draft = ''; state.open = false;
    forget();
    /* the aborted request must not write the conversation back */
    save = function () {};
  });
  document.addEventListener('dislab-admin-ready', start);
  if (A.user) { start(); }
})();
