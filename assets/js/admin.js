/*
 * Shared admin shell for the DIS Lab site: session handling, header, forms,
 * list/CRUD panels, confirm dialog and toasts. Page definitions live in admin-pages.js.
 * Requires assets/js/config.js and assets/js/site.js (DISLAB helpers) to be loaded first.
 *
 * Security notes (the login token lives in localStorage, so these pages must not have XSS):
 *   - Data from the API is only ever written with textContent / form .value, never innerHTML.
 *   - URLs from the API go through DISLAB.safeUrl before reaching href / src.
 *   - The admin pages ship a CSP that forbids inline scripts; keep all JS in files.
 *   - The token and password are never put in URLs or logged.
 */
(function () {
  'use strict';

  var API = window.DISLAB_API_BASE;
  var safeUrl = window.DISLAB.safeUrl;

  var TOKEN_KEY = 'adminToken';              /* localStorage (same key the old pages used) */
  var NOTICE_KEY = 'dislabAdminNotice';      /* sessionStorage: message for the login page */
  var RETURN_KEY = 'dislabAdminReturn';      /* sessionStorage: page to return to after login */
  var DRAFT_KEY = 'dislabAdminDraft';        /* sessionStorage: form input saved on session expiry */
  var TIMEOUT_MS = 15000;
  var LOGIN_PAGE = 'login.html';
  var HOME_PAGE = 'admin5504.html';
  var PAGES = [
    ['admin5504.html', 'Publications'],
    ['admin_members.html', 'Members'],
    ['admin_news.html', 'News'],
    ['admin_research.html', 'Research'],
    ['admin_projects.html', 'Projects']
  ];

  var forms = [];          /* every form on the page, for the unsaved-changes guard */
  var leaving = false;     /* true once we navigate away on purpose */

  /* ---------- storage ---------- */

  function store(kind) { try { return window[kind]; } catch (e) { return null; } }
  function sGet(kind, key) { try { return store(kind).getItem(key); } catch (e) { return null; } }
  function sSet(kind, key, value) { try { store(kind).setItem(key, value); } catch (e) { /* ignore */ } }
  function sDel(kind, key) { try { store(kind).removeItem(key); } catch (e) { /* ignore */ } }

  function getToken() { return sGet('localStorage', TOKEN_KEY) || ''; }
  function setToken(t) { sSet('localStorage', TOKEN_KEY, t); }
  function clearToken() { sDel('localStorage', TOKEN_KEY); }

  function currentPage() { return window.location.pathname.split('/').pop() || 'index.html'; }
  function isAdminPage(name) { return PAGES.some(function (p) { return p[0] === name; }); }

  function go(page) { leaving = true; window.location.replace(page); }

  /* ---------- DOM helpers ---------- */

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) { return; }
      if (k === 'class') { node.className = v; }
      else if (k === 'text') { node.textContent = v; }
      else if (k === 'on') { Object.keys(v).forEach(function (ev) { node.addEventListener(ev, v[ev]); }); }
      else { node.setAttribute(k, v === true ? '' : v); }
    });
    [].concat(children || []).forEach(function (c) {
      if (c == null || c === false) { return; }
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function clear(node) { while (node.firstChild) { node.removeChild(node.firstChild); } }

  var uid = 0;
  function nextId(prefix) { uid += 1; return prefix + '-' + uid; }

  /* Static, data-free SVG markup only. */
  var ICONS = {
    error: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4.5"/><circle cx="12" cy="17.2" r=".6" fill="currentColor"/></svg>',
    empty: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5.5 5h13L21 13v6H3v-6l2.5-8z"/></svg>'
  };

  function stateBlock(kind, title, text, onRetry) {
    var icon = el('div', { class: 'state-icon' });
    icon.innerHTML = ICONS[kind];
    return el('div', { class: 'state state--' + kind, role: kind === 'error' ? 'alert' : 'status' }, [
      icon,
      el('p', { class: 'state-title', text: title }),
      text ? el('p', { class: 'state-text', text: text }) : null,
      onRetry ? el('button', { type: 'button', class: 'btn btn--outline', text: 'Try again', on: { click: onRetry } }) : null
    ]);
  }

  function skeleton(count) {
    var list = el('div', { class: 'skeleton-list', 'aria-hidden': 'true' });
    for (var i = 0; i < (count || 3); i++) {
      list.appendChild(el('div', { class: 'skeleton' }, [el('span'), el('span'), el('span')]));
    }
    return el('div', {}, [list, el('p', { class: 'sr-only', role: 'status', text: 'Loading…' })]);
  }

  /* ---------- API ---------- */

  function request(method, path, body, withAuth) {
    var headers = {};
    var init = { method: method, headers: headers, cache: 'no-store' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    if (withAuth) {
      var token = getToken();
      if (token) { headers.Authorization = 'Bearer ' + token; }
    }
    var controller = window.AbortController ? new AbortController() : null;
    if (controller) { init.signal = controller.signal; }
    var timer = setTimeout(function () { if (controller) { controller.abort(); } }, TIMEOUT_MS);

    return fetch(API + path, init).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = JSON.parse(text); } catch (e) { /* non-JSON body */ }
        return { status: res.status, ok: res.ok, data: data };
      });
    }, function () {
      var err = new Error('Could not reach the server. Check your connection and try again.');
      err.network = true;
      throw err;
    }).then(function (r) { clearTimeout(timer); return r; }, function (e) { clearTimeout(timer); throw e; });
  }

  function errorFor(r) {
    var msg = r.data && typeof r.data.error === 'string' ? r.data.error : '';
    var text;
    if (r.status === 400) { text = msg || 'The server rejected this input.'; }
    else if (r.status === 404) { text = (msg || 'Not found') + '. It may have been deleted already.'; }
    else if (r.status === 413) { text = 'This entry is too large to save. Shorten the text and try again.'; }
    else if (r.status === 429) { text = 'Too many requests. Please wait a moment and try again.'; }
    else if (r.status >= 500) { text = 'The server had a problem (HTTP ' + r.status + '). Nothing was saved; please try again.'; }
    else { text = msg || 'Request failed (HTTP ' + r.status + ').'; }
    var err = new Error(text);
    err.status = r.status;
    err.serverMessage = msg;
    return err;
  }

  /* Public list read (no auth needed), never served from cache so edits show up at once. */
  function read(path) {
    return request('GET', path).then(function (r) {
      if (!r.ok) { throw errorFor(r); }
      return r.data;
    });
  }

  /*
   * Authenticated write. On 401 the session is gone: remember any unsaved input,
   * drop the token and go to the login page (the returned promise then never settles,
   * so the UI stays locked while the page unloads).
   */
  function write(path, body, getDraft) {
    return request('POST', path, body, true).then(function (r) {
      if (r.status === 401) {
        sessionExpired(getDraft ? getDraft() : null);
        return new Promise(function () {});
      }
      if (!r.ok) { throw errorFor(r); }
      return r.data || {};
    });
  }

  function sessionExpired(draft) {
    clearToken();
    if (draft) { sSet('sessionStorage', DRAFT_KEY, JSON.stringify(draft)); }
    sSet('sessionStorage', NOTICE_KEY, draft ? 'expired-draft' : 'expired');
    sSet('sessionStorage', RETURN_KEY, currentPage());
    go(LOGIN_PAGE);
  }

  /* ---------- toasts ---------- */

  var toastRegion;
  function toast(message, kind) {
    if (!toastRegion) {
      toastRegion = el('div', { class: 'toast-region', role: 'status', 'aria-live': 'polite' });
      document.body.appendChild(toastRegion);
    }
    var node = el('div', { class: 'toast toast--' + (kind || 'ok') }, [
      el('span', { text: message }),
      el('button', { type: 'button', class: 'toast-close', 'aria-label': 'Dismiss', text: '×', on: { click: remove } })
    ]);
    function remove() { if (node.parentNode) { node.parentNode.removeChild(node); } }
    toastRegion.appendChild(node);
    setTimeout(remove, kind === 'error' ? 8000 : 4500);
  }

  /* ---------- confirm dialog ---------- */

  function confirmDialog(opts) {
    return new Promise(function (resolve) {
      var listing = null;
      if (opts.items && opts.items.length) {
        listing = el('ul', { class: 'confirm-items' }, opts.items.slice(0, 6).map(function (t) { return el('li', { text: t }); }));
        if (opts.items.length > 6) { listing.appendChild(el('li', { class: 'more', text: '… and ' + (opts.items.length - 6) + ' more' })); }
      }
      if (typeof window.HTMLDialogElement !== 'function') {
        resolve(window.confirm(opts.title + (opts.text ? '\n\n' + opts.text : '')));
        return;
      }
      var cancel = el('button', { type: 'button', class: 'btn btn--outline', text: opts.cancelLabel || 'Cancel' });
      var ok = el('button', { type: 'button', class: 'btn ' + (opts.danger ? 'btn--danger' : 'btn--solid'), text: opts.okLabel || 'OK', 'data-confirm-ok': true });
      var dlg = el('dialog', { class: 'confirm' }, [
        el('h2', { text: opts.title }),
        opts.text ? el('p', { text: opts.text }) : null,
        listing,
        el('div', { class: 'confirm-actions' }, [cancel, ok])
      ]);
      var result = false;
      cancel.addEventListener('click', function () { dlg.close(); });
      ok.addEventListener('click', function () { result = true; dlg.close(); });
      dlg.addEventListener('close', function () {
        if (dlg.parentNode) { dlg.parentNode.removeChild(dlg); }
        resolve(result);
      });
      document.body.appendChild(dlg);
      dlg.showModal();
      cancel.focus();
    });
  }

  /* ---------- forms ---------- */

  var CUSTOM = '__custom__';

  function buildControl(field) {
    var id = nextId('f-' + field.name);
    var hintId = field.hint ? id + '-hint' : null;
    var input, extra = null, select = null;
    var common = { id: id, name: field.name, required: !!field.required, 'aria-describedby': hintId };

    if (field.type === 'textarea') {
      input = el('textarea', Object.assign({ rows: field.rows || 4, maxlength: field.max, placeholder: field.placeholder }, common));
    } else if (field.type === 'select') {
      select = el('select', common, field.options.map(function (o) {
        return el('option', { value: o[0], text: o[1] || o[0] });
      }));
      if (field.custom) {
        select.appendChild(el('option', { value: CUSTOM, text: 'Other (type your own)…' }));
        extra = el('input', {
          type: 'text', class: 'custom-input', maxlength: field.max, hidden: true,
          placeholder: field.customPlaceholder || 'Custom value', 'aria-label': field.label + ' (custom value)'
        });
        select.addEventListener('change', function () { syncCustom(true); });
      }
      input = select;
    } else {
      input = el('input', Object.assign({
        type: field.type || 'text', maxlength: field.max, placeholder: field.placeholder,
        autocomplete: 'off', spellcheck: field.type && field.type !== 'text' ? null : 'false',
        inputmode: field.inputmode
      }, common));
    }

    function syncCustom(focus) {
      if (!extra) { return; }
      var on = select.value === CUSTOM;
      extra.hidden = !on;
      extra.required = on && !!field.required;
      if (on && focus) { extra.focus(); }
    }

    var root = el('div', { class: 'field' + (field.wide ? ' field--wide' : '') }, [
      el('label', { for: id }, [field.label, field.required ? null : el('span', { class: 'optional', text: ' (optional)' })]),
      input,
      extra,
      field.hint ? el('p', { class: 'hint', id: hintId, text: field.hint }) : null
    ]);

    return {
      field: field,
      root: root,
      focusTarget: function () { return extra && !extra.hidden ? extra : input; },
      inputs: extra ? [input, extra] : [input],
      get: function () {
        var v = select && extra && select.value === CUSTOM ? extra.value : input.value;
        return String(v == null ? '' : v).trim();
      },
      set: function (value) {
        var v = value == null ? '' : String(value);
        if (field.toForm) { v = field.toForm(v); }
        if (select) {
          var known = field.options.some(function (o) { return o[0] === v; });
          if (known) { select.value = v; if (extra) { extra.value = ''; } }
          else if (v && extra) { select.value = CUSTOM; extra.value = v; }
          else if (v) { select.appendChild(el('option', { value: v, text: v })); select.value = v; }
          else { select.selectedIndex = 0; if (extra) { extra.value = ''; } }
          syncCustom(false);
        } else if (field.type === 'date' || field.type === 'month') {
          /* Existing free-form values that a date picker cannot show are edited as plain text. */
          var pattern = field.type === 'date' ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}$/;
          input.type = !v || pattern.test(v) ? field.type : 'text';
          input.value = v;
        } else {
          input.value = v;
        }
      },
      invalid: function (on) {
        root.classList.toggle('is-invalid', !!on);
        this.inputs.forEach(function (i) { if (on) { i.setAttribute('aria-invalid', 'true'); } else { i.removeAttribute('aria-invalid'); } });
      }
    };
  }

  /*
   * buildForm({ key, fields, submitLabel, onSubmit(values, form) -> Promise, onReset })
   * Handles busy state, inline server errors, dirty tracking.
   */
  function buildForm(cfg) {
    var controls = cfg.fields.map(buildControl);
    var alertBox = el('div', { class: 'form-alert', role: 'alert', hidden: true });
    var submit = el('button', { type: 'submit', class: 'btn btn--solid', text: cfg.submitLabel });
    var reset = el('button', { type: 'button', class: 'btn btn--outline', text: cfg.resetLabel || 'Clear' });
    var node = el('form', { class: 'admin-form', autocomplete: 'off' }, [
      el('div', { class: 'form-grid' }, controls.map(function (c) { return c.root; })),
      alertBox,
      el('div', { class: 'form-actions' }, [submit, reset])
    ]);

    var submitLabel = cfg.submitLabel;
    var form = {
      key: cfg.key,
      node: node,
      dirty: false,
      busy: false,
      submit: submit,
      reset: reset,
      values: function () {
        var out = {};
        controls.forEach(function (c) { out[c.field.name] = c.field.fromForm ? c.field.fromForm(c.get()) : c.get(); });
        return out;
      },
      fill: function (data) {
        controls.forEach(function (c) { c.set(data ? data[c.field.name] : ''); });
        form.clearError();
        form.dirty = false;
      },
      setBusy: function (on, label) {
        form.busy = on;
        submit.disabled = on; reset.disabled = on;
        submit.textContent = on ? (label || 'Saving…') : submitLabel;
        node.setAttribute('aria-busy', on ? 'true' : 'false');
      },
      showError: function (message, serverMessage) {
        alertBox.className = 'form-alert form-alert--error';
        alertBox.textContent = message;
        alertBox.hidden = false;
        /* Server validation messages start with the field name ("github must be …"). */
        var first = String(serverMessage || '').split(' ')[0];
        controls.forEach(function (c) {
          var hit = !!first && c.field.name === first;
          c.invalid(hit);
          if (hit) { c.focusTarget().focus(); }
        });
      },
      showInfo: function (message) {
        alertBox.className = 'form-alert form-alert--info';
        alertBox.textContent = message;
        alertBox.hidden = false;
      },
      clearError: function () {
        alertBox.hidden = true; alertBox.textContent = '';
        controls.forEach(function (c) { c.invalid(false); });
      },
      setSubmitLabel: function (text) { submitLabel = text; if (!form.busy) { submit.textContent = text; } },
      focusFirst: function () { controls[0].focusTarget().focus(); }
    };

    node.addEventListener('input', function () { form.dirty = true; });
    node.addEventListener('change', function () { form.dirty = true; });
    node.addEventListener('submit', function (e) {
      e.preventDefault();
      if (form.busy) { return; }
      form.clearError();
      form.setBusy(true);
      cfg.onSubmit(form.values(), form).then(function () {
        form.setBusy(false);
      }, function (err) {
        form.setBusy(false);
        form.showError(err.message, err.serverMessage);
        toast(err.message, 'error');
      });
    });
    reset.addEventListener('click', function () {
      if (form.busy) { return; }
      var proceed = form.dirty
        ? confirmDialog({ title: 'Discard what you typed?', text: 'The form has unsaved input.', okLabel: 'Discard', danger: true })
        : Promise.resolve(true);
      proceed.then(function (yes) { if (yes) { cfg.onReset(form); } });
    });

    forms.push(form);
    form.fill(null);
    return form;
  }

  function panel(title, children, lead) {
    var heading = el('h2', { class: 'panel-title', text: title });
    var node = el('section', { class: 'card admin-panel' }, [
      heading,
      lead ? el('p', { class: 'panel-lead', text: lead }) : null
    ].concat(children));
    return { node: node, heading: heading };
  }

  function takeDraft(key) {
    var raw = sGet('sessionStorage', DRAFT_KEY);
    if (!raw) { return null; }
    try {
      var d = JSON.parse(raw);
      if (d && d.page === currentPage() && d.key === key && d.values && typeof d.values === 'object') {
        sDel('sessionStorage', DRAFT_KEY);
        return d;
      }
    } catch (e) { sDel('sessionStorage', DRAFT_KEY); }
    return null;
  }

  /* ---------- single-record form (professor) ---------- */

  function single(cfg) {
    var body = el('div');
    var p = panel(cfg.title, [body], cfg.lead);
    var form = buildForm({
      key: cfg.key, fields: cfg.fields, submitLabel: cfg.submitLabel || 'Save changes', resetLabel: 'Revert',
      onSubmit: function (values) {
        return write(cfg.savePath, values, function () { return { page: currentPage(), key: cfg.key, values: values }; })
          .then(function (data) {
            saved = values;
            form.fill(values);
            toast(data.message || 'Saved', 'ok');
          });
      },
      onReset: function () { form.fill(saved); }
    });
    var saved = null;

    function load() {
      clear(body);
      body.appendChild(skeleton(2));
      request('GET', cfg.loadPath).then(function (r) {
        if (!r.ok && r.status !== 404) { throw errorFor(r); }
        saved = r.ok && r.data && typeof r.data === 'object' ? r.data : null;
        clear(body);
        body.appendChild(form.node);
        form.fill(saved);
        if (!saved) { form.showInfo('No record exists yet. Fill in the form and save to create it.'); }
        var draft = takeDraft(cfg.key);
        if (draft) {
          form.fill(draft.values);
          form.dirty = true;
          form.showInfo('Your unsaved input was restored after signing in again. Review it and save.');
        }
      }).catch(function (err) {
        clear(body);
        body.appendChild(stateBlock('error', 'Couldn’t load ' + cfg.label, err.message, load));
      });
    }
    load();
    return p.node;
  }

  /* ---------- list + add / edit / delete ---------- */

  /*
   * crud({ key, singular, plural, listPath, addPath, updatePath, deletePath,
   *        fields, columns: [{ label, render(item) -> Node|string, cls }], name(item), filter, sort })
   */
  function crud(cfg) {
    var items = [];
    var editingId = null;
    var selected = {};
    var busy = false;
    var query = '';

    /* --- form panel --- */
    var editNote = el('p', { class: 'edit-note', hidden: true });
    var form = buildForm({
      key: cfg.key, fields: cfg.fields, submitLabel: 'Add ' + cfg.singular,
      onSubmit: function (values) {
        var id = editingId;
        var body = Object.assign({}, values);
        if (id != null) { body.id = id; }
        return write(id != null ? cfg.updatePath : cfg.addPath, body, function () {
          return { page: currentPage(), key: cfg.key, values: values, id: id };
        }).then(function (data) {
          toast(data.message || 'Saved', 'ok');
          setMode(null);
          load(true);
        }, function (err) {
          if (err.status === 404) { load(true); }
          throw err;
        });
      },
      onReset: function () { setMode(null); }
    });
    var formPanel = panel('Add ' + cfg.singular, [editNote, form.node]);

    function setMode(item, values) {
      editingId = item ? item.id : null;
      formPanel.heading.textContent = item ? 'Edit ' + cfg.singular : 'Add ' + cfg.singular;
      formPanel.node.classList.toggle('is-editing', !!item);
      form.setSubmitLabel(item ? 'Save changes' : 'Add ' + cfg.singular);
      form.reset.textContent = item ? 'Cancel edit' : 'Clear';
      editNote.hidden = !item;
      editNote.textContent = item ? 'Editing #' + item.id + (cfg.name(item) ? ' — ' + cfg.name(item) : '') + '. Saving replaces the whole record.' : '';
      form.fill(values || item || null);
      renderRows();
    }

    function startEdit(item) {
      var proceed = form.dirty
        ? confirmDialog({ title: 'Discard what you typed?', text: 'The form has unsaved input that will be replaced.', okLabel: 'Discard', danger: true })
        : Promise.resolve(true);
      proceed.then(function (yes) {
        if (!yes) { return; }
        setMode(item);
        formPanel.node.scrollIntoView({ block: 'start' });
        form.focusFirst();
      });
    }

    /* --- list panel --- */
    var count = el('span', { class: 'count' });
    var filterInput = el('input', { type: 'search', class: 'list-filter', placeholder: 'Filter ' + cfg.plural + '…', 'aria-label': 'Filter ' + cfg.plural, hidden: !cfg.filter });
    var refreshBtn = el('button', { type: 'button', class: 'btn btn--outline btn--small', text: 'Refresh' });
    var deleteBtn = el('button', { type: 'button', class: 'btn btn--danger btn--small', text: 'Delete selected', disabled: true });
    var listBody = el('div', { class: 'list-body' });
    var listPanel = panel('', [
      el('div', { class: 'list-toolbar' }, [filterInput, el('div', { class: 'list-actions' }, [refreshBtn, deleteBtn])]),
      listBody
    ]);
    listPanel.heading.textContent = cfg.listTitle + ' ';
    listPanel.heading.appendChild(count);

    function selectedIds() {
      return items.filter(function (i) { return selected[i.id]; }).map(function (i) { return i.id; });
    }

    function syncToolbar() {
      var n = selectedIds().length;
      deleteBtn.disabled = busy || n === 0;
      deleteBtn.textContent = n ? 'Delete selected (' + n + ')' : 'Delete selected';
      refreshBtn.disabled = busy;
      Array.prototype.forEach.call(listBody.querySelectorAll('button, input[type="checkbox"]'), function (b) { b.disabled = busy; });
    }

    function visibleItems() {
      var q = query.trim().toLowerCase();
      if (!q) { return items; }
      return items.filter(function (item) {
        return Object.keys(item).some(function (k) { return String(item[k] == null ? '' : item[k]).toLowerCase().indexOf(q) !== -1; });
      });
    }

    function renderRows() {
      clear(listBody);
      count.textContent = items.length ? String(items.length) : '';
      if (!items.length) {
        listBody.appendChild(stateBlock('empty', 'No ' + cfg.plural + ' yet', 'Use the form above to add the first one.'));
        syncToolbar();
        return;
      }
      var shown = visibleItems();
      if (!shown.length) {
        listBody.appendChild(stateBlock('empty', 'No ' + cfg.plural + ' match the filter', 'Clear the filter to see all ' + items.length + '.'));
        syncToolbar();
        return;
      }

      var all = el('input', { type: 'checkbox', 'aria-label': 'Select all shown' });
      all.checked = shown.every(function (i) { return selected[i.id]; });
      all.addEventListener('change', function () {
        shown.forEach(function (i) { if (all.checked) { selected[i.id] = true; } else { delete selected[i.id]; } });
        renderRows();
      });

      var head = el('tr', {}, [el('th', { class: 'col-check', scope: 'col' }, [all]), el('th', { scope: 'col', class: 'col-id', text: 'ID' })]
        .concat(cfg.columns.map(function (c) { return el('th', { scope: 'col', text: c.label }); }))
        .concat([el('th', { scope: 'col', class: 'col-actions', text: 'Actions' })]));

      var rows = shown.map(function (item) {
        var label = cfg.name(item) || ('#' + item.id);
        var check = el('input', { type: 'checkbox', 'aria-label': 'Select ' + label });
        check.checked = !!selected[item.id];
        check.addEventListener('change', function () {
          if (check.checked) { selected[item.id] = true; } else { delete selected[item.id]; }
          syncToolbar();
        });
        var cells = cfg.columns.map(function (c) {
          var content = c.render(item);
          return el('td', { class: c.cls, 'data-label': c.label }, [content == null || content === '' ? el('span', { class: 'muted', text: '—' }) : content]);
        });
        return el('tr', { class: item.id === editingId ? 'is-editing' : null, 'data-id': String(item.id) }, [
          el('td', { class: 'col-check' }, [check]),
          el('td', { class: 'col-id', 'data-label': 'ID', text: String(item.id) })
        ].concat(cells).concat([
          el('td', { class: 'col-actions' }, [
            el('button', { type: 'button', class: 'btn btn--outline btn--small', text: 'Edit', 'aria-label': 'Edit ' + label, 'data-action': 'edit', on: { click: function () { startEdit(item); } } }),
            el('button', { type: 'button', class: 'btn btn--danger-outline btn--small', text: 'Delete', 'aria-label': 'Delete ' + label, 'data-action': 'delete', on: { click: function () { remove([item]); } } })
          ])
        ]));
      });

      listBody.appendChild(el('div', { class: 'table-wrap' }, [
        el('table', { class: 'admin-table' }, [el('thead', {}, [head]), el('tbody', {}, rows)])
      ]));
      syncToolbar();
    }

    function load(keepView) {
      if (!keepView) { clear(listBody); listBody.appendChild(skeleton(3)); }
      busy = true; syncToolbar();
      return read(cfg.listPath).then(function (data) {
        items = Array.isArray(data) ? data : [];
        if (cfg.sort) { items = cfg.sort(items); }
        var ids = {};
        items.forEach(function (i) { ids[i.id] = true; });
        Object.keys(selected).forEach(function (id) { if (!ids[id]) { delete selected[id]; } });
        if (editingId != null && !ids[editingId]) {
          editNote.textContent = 'This record no longer exists on the server. Cancel the edit, or copy what you need first.';
        }
        busy = false;
        renderRows();
      }).catch(function (err) {
        busy = false;
        clear(listBody);
        listBody.appendChild(stateBlock('error', 'Couldn’t load the ' + cfg.plural, err.message, function () { load(); }));
        syncToolbar();
      });
    }

    function remove(targets) {
      if (busy || !targets.length) { return; }
      var one = targets.length === 1;
      confirmDialog({
        title: one ? 'Delete this ' + cfg.singular + '?' : 'Delete ' + targets.length + ' ' + cfg.plural + '?',
        text: 'This cannot be undone.',
        items: targets.map(function (t) { return '#' + t.id + ' ' + (cfg.name(t) || ''); }),
        okLabel: 'Delete', danger: true
      }).then(function (yes) {
        if (!yes) { return; }
        busy = true; syncToolbar();
        var ids = targets.map(function (t) { return t.id; });
        write(cfg.deletePath, { ids: ids }, function () {
          return form.dirty ? { page: currentPage(), key: cfg.key, values: form.values(), id: editingId } : null;
        }).then(function () {
          toast(one ? 'Deleted “' + (cfg.name(targets[0]) || '#' + ids[0]) + '”' : 'Deleted ' + ids.length + ' ' + cfg.plural, 'ok');
          ids.forEach(function (id) { delete selected[id]; });
          if (editingId != null && ids.indexOf(editingId) !== -1) { setMode(null); }
          busy = false;
          load(true);
        }, function (err) {
          busy = false; syncToolbar();
          toast(err.message, 'error');
        });
      });
    }

    refreshBtn.addEventListener('click', function () { load(); });
    deleteBtn.addEventListener('click', function () {
      var ids = selectedIds();
      remove(items.filter(function (i) { return ids.indexOf(i.id) !== -1; }));
    });
    filterInput.addEventListener('input', function () { query = filterInput.value; renderRows(); });

    var draft = takeDraft(cfg.key);
    if (draft) {
      if (typeof draft.id === 'number') { setMode({ id: draft.id }, draft.values); }
      else { form.fill(draft.values); }
      form.dirty = true;
      form.showInfo('Your unsaved input was restored after signing in again. Review it and save.');
    }
    load();

    return [formPanel.node, listPanel.node];
  }

  /* ---------- cell helpers for page definitions ---------- */

  function linkCell(url, label) {
    var safe = safeUrl(url);
    if (!safe) { return null; }
    return el('a', { href: safe, target: '_blank', rel: 'noopener noreferrer', text: label || safe });
  }

  function thumbCell(url, alt) {
    var safe = safeUrl(url);
    if (!safe) { return null; }
    var img = el('img', { class: 'thumb', src: safe, alt: alt || '', loading: 'lazy' });
    img.addEventListener('error', function () {
      if (img.parentNode) { img.parentNode.replaceChild(el('span', { class: 'muted', text: 'no image' }), img); }
    }, { once: true });
    return img;
  }

  function stack(main, sub) {
    return el('div', { class: 'cell-stack' }, [el('strong', { text: main || '' }), sub ? el('span', { text: sub }) : null]);
  }

  /* ---------- shell ---------- */

  function buildShell(page) {
    var userLabel = el('span', { class: 'admin-user', text: 'Checking session…' });
    var logoutBtn = el('button', { type: 'button', class: 'btn btn--ghost btn--small', text: 'Log out', disabled: true });
    var nav = el('nav', { id: 'site-nav', class: 'site-nav', 'aria-label': 'Admin sections' },
      PAGES.map(function (p) { return el('a', { href: p[0], text: p[1] }); }).concat([
        el('span', { class: 'admin-nav-meta' }, [
          userLabel,
          el('a', { href: 'index.html', class: 'admin-site-link', text: 'View public site' }),
          logoutBtn
        ])
      ]));
    var header = el('header', { class: 'site-header admin-header' }, [
      el('div', { class: 'container header-inner' }, [
        el('a', { class: 'brand', href: HOME_PAGE, 'aria-label': 'DIS Lab admin' }, [
          el('img', { src: 'src/img/lab_logo.png', width: '1280', height: '500', alt: 'DIS Lab' }),
          el('span', { class: 'admin-badge', text: 'Admin' })
        ]),
        el('button', { type: 'button', class: 'nav-toggle', 'aria-label': 'Menu', 'aria-expanded': 'false', 'aria-controls': 'site-nav' }, [el('span'), el('span'), el('span')]),
        nav
      ])
    ]);
    var root = el('div', { class: 'container admin-root' });
    var main = el('main', {}, [
      el('div', { class: 'page-head' }, [el('div', { class: 'container' }, [
        el('h1', { text: page.title }),
        el('p', { text: page.lead })
      ])]),
      el('section', { class: 'section' }, [root])
    ]);
    var footer = el('footer', { class: 'site-footer admin-footer' }, [
      el('div', { class: 'container footer-bottom' }, [el('span', { text: '© DIS Lab, Chungnam National University · Site administration' })])
    ]);
    document.body.insertBefore(footer, document.body.firstChild);
    document.body.insertBefore(main, footer);
    document.body.insertBefore(header, main);
    return { root: root, userLabel: userLabel, logoutBtn: logoutBtn };
  }

  function anyDirty() { return forms.some(function (f) { return f.dirty; }); }

  function logout(button) {
    var proceed = anyDirty()
      ? confirmDialog({ title: 'Log out and discard unsaved input?', text: 'A form on this page has input that has not been saved.', okLabel: 'Log out', danger: true })
      : Promise.resolve(true);
    proceed.then(function (yes) {
      if (!yes) { return; }
      button.disabled = true;
      button.textContent = 'Logging out…';
      function done() {
        clearToken();
        sDel('sessionStorage', DRAFT_KEY);
        sDel('sessionStorage', RETURN_KEY);
        sSet('sessionStorage', NOTICE_KEY, 'loggedout');
        go(LOGIN_PAGE);
      }
      /* Revoke server-side; the local token is dropped even if the server cannot be reached. */
      request('POST', '/api/logout', undefined, true).then(done, done);
    });
  }

  /* start({ title, lead, render(root) -> Node[] }) */
  function start(page) {
    if (!getToken()) {
      sSet('sessionStorage', NOTICE_KEY, 'required');
      sSet('sessionStorage', RETURN_KEY, currentPage());
      go(LOGIN_PAGE);
      return;
    }
    var shell = buildShell(page);
    shell.logoutBtn.addEventListener('click', function () { logout(shell.logoutBtn); });

    window.addEventListener('beforeunload', function (e) {
      if (!leaving && anyDirty()) { e.preventDefault(); e.returnValue = ''; }
    });
    /* Logged out (or expired) in another tab. */
    window.addEventListener('storage', function (e) {
      if (e.key === TOKEN_KEY && !e.newValue && !leaving) { sessionExpired(null); }
    });

    function verify() {
      clear(shell.root);
      shell.root.appendChild(skeleton(2));
      request('GET', '/api/me', undefined, true).then(function (r) {
        if (r.status === 401) { sessionExpired(null); return; }
        if (!r.ok) { throw errorFor(r); }
        shell.userLabel.textContent = 'Signed in as ';
        shell.userLabel.appendChild(el('strong', { text: String((r.data && r.data.username) || 'admin') }));
        shell.logoutBtn.disabled = false;
        clear(shell.root);
        page.render().forEach(function (node) { shell.root.appendChild(node); });
      }).catch(function (err) {
        shell.userLabel.textContent = 'Not verified';
        shell.logoutBtn.disabled = false;
        clear(shell.root);
        shell.root.appendChild(stateBlock('error', 'Couldn’t verify your session', err.message, verify));
      });
    }
    verify();
  }

  /* ---------- login page ---------- */

  var NOTICES = {
    'expired': ['warn', 'Your session has expired. Please sign in again.'],
    'expired-draft': ['warn', 'Your session has expired. Please sign in again — what you typed was kept and will be restored.'],
    'required': ['info', 'Please sign in to manage the site.'],
    'loggedout': ['ok', 'You have been signed out.']
  };

  function waitText(seconds) {
    var m = Math.floor(seconds / 60), s = seconds % 60;
    if (m && s) { return m + ' min ' + s + ' s'; }
    if (m) { return m + ' min'; }
    return s + ' s';
  }

  function login() {
    var form = document.getElementById('loginForm');
    var user = document.getElementById('username');
    var pass = document.getElementById('password');
    var button = document.getElementById('loginSubmit');
    var message = document.getElementById('loginMessage');
    var lockTimer = null;
    var busy = false;

    function show(kind, text) {
      message.className = 'form-alert form-alert--' + kind;
      message.textContent = text;
      message.hidden = !text;
    }

    function destination() {
      var back = sGet('sessionStorage', RETURN_KEY);
      sDel('sessionStorage', RETURN_KEY);
      return back && isAdminPage(back) ? back : HOME_PAGE;
    }

    function lockFor(seconds) {
      var until = Date.now() + seconds * 1000;
      clearInterval(lockTimer);
      function tick() {
        var left = Math.ceil((until - Date.now()) / 1000);
        if (left <= 0) {
          clearInterval(lockTimer); lockTimer = null;
          button.disabled = false;
          show('info', 'You can try signing in again now.');
          return;
        }
        button.disabled = true;
        show('error', 'Too many failed sign-in attempts. Please wait ' + waitText(left) + ' before trying again.');
      }
      tick();
      lockTimer = setInterval(tick, 1000);
    }

    var notice = sGet('sessionStorage', NOTICE_KEY);
    sDel('sessionStorage', NOTICE_KEY);
    if (notice && NOTICES[notice]) { show(NOTICES[notice][0], NOTICES[notice][1]); }

    /* Already signed in with a valid token: go straight to the admin pages. */
    if (getToken() && !notice) {
      request('GET', '/api/me', undefined, true).then(function (r) {
        if (r.ok) { go(destination()); }
        else if (r.status === 401) { clearToken(); }
      }, function () { /* offline: stay on the form */ });
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (busy || lockTimer) { return; }
      busy = true;
      button.disabled = true;
      button.textContent = 'Signing in…';
      show('info', '');

      request('POST', '/api/login', { username: user.value, password: pass.value }).then(function (r) {
        busy = false;
        button.textContent = 'Sign in';
        button.disabled = false;
        if (r.ok && r.data && typeof r.data.token === 'string' && r.data.token) {
          pass.value = '';
          setToken(r.data.token);
          show('ok', 'Signed in. Redirecting…');
          button.disabled = true;
          go(destination());
          return;
        }
        pass.value = '';
        if (r.status === 429) {
          var wait = parseInt(r.data && r.data.retry_after, 10);
          lockFor(wait > 0 ? wait : 30);
        } else if (r.status === 401) {
          show('error', 'Incorrect username or password.');
          pass.focus();
        } else if (r.status === 400) {
          show('error', 'The sign-in request was not accepted. Reload the page and try again.');
        } else {
          show('error', 'The server had a problem (HTTP ' + r.status + '). Please try again shortly.');
        }
      }, function (err) {
        busy = false;
        button.textContent = 'Sign in';
        button.disabled = false;
        show('error', err.message);
      });
    });
  }

  window.DISADMIN = {
    el: el,
    start: start,
    login: login,
    crud: crud,
    single: single,
    linkCell: linkCell,
    thumbCell: thumbCell,
    stack: stack
  };
})();
