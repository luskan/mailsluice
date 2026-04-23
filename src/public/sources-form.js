(function () {
  var form = document.getElementById('source-form');
  var testBtn = document.getElementById('test-btn');
  var testOut = document.getElementById('test-result');
  var discoverBtn = document.getElementById('discover-btn');
  var discoverOut = document.getElementById('discover-result');
  var typeSel = form && form.querySelector('select[name="type"]');
  var pollWrap = document.getElementById('poll-wrap');
  var tbody = document.getElementById('folders-tbody');
  var tableWrap = document.getElementById('folders-table-wrap');
  var emptyMsg = document.getElementById('folders-empty');
  var rowTpl = document.getElementById('folder-row-tpl');
  var labelPrefixInput = document.getElementById('label-prefix');
  var nameInput = form && form.querySelector('input[name="name"]');
  var foldersJsonField = document.getElementById('folders-json');
  var foldersHint = document.getElementById('folders-hint');
  var saveBtn = document.getElementById('save-btn');
  var saveHint = document.getElementById('save-hint');
  var suggestList = document.getElementById('folder-label-suggestions');
  var initialDataNode = document.getElementById('folders-initial');
  var initial = [];
  try { initial = JSON.parse(initialDataNode.textContent || '[]'); } catch (_) { initial = []; }

  if (!form) return;

  var testPassed = false;
  var hasDiscovered = initial && initial.length > 0;
  var prefixManuallyChanged = Boolean(labelPrefixInput && labelPrefixInput.value);

  function currentType() {
    return typeSel ? typeSel.value : 'imap';
  }

  function isImap() { return currentType() === 'imap'; }

  function updateTypeUi() {
    if (pollWrap) pollWrap.style.display = isImap() ? 'none' : '';
    var foldersCard = document.getElementById('folders-card');
    if (foldersCard) foldersCard.style.display = isImap() ? '' : 'none';
    updateSaveState();
  }

  function sanitizeLabel(s) {
    if (!s) return '';
    return String(s).replace(/\s+/g, ' ').trim().replace(/^\/+|\/+$/g, '').replace(/\/\/+/g, '/');
  }

  function autoLabelFor(path, prefix) {
    var p = sanitizeLabel(prefix);
    if (!p) p = 'Imported';
    if (path === 'INBOX') return p;
    // Normalize the server delimiter to '/'. ImapFlow already normalizes
    // paths with '/' in most cases; we still defensively collapse.
    var tail = String(path).replace(/^INBOX[\/.]/, '').replace(/\./g, '/');
    return p + '/' + tail;
  }

  function readRows() {
    var rows = tbody ? tbody.querySelectorAll('tr.folder-row') : [];
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var tr = rows[i];
      var path = tr.getAttribute('data-path') || '';
      var cb = tr.querySelector('.folder-sync');
      var inp = tr.querySelector('.folder-label');
      out.push({
        path: path,
        label: inp ? inp.value : '',
        enabled: cb ? cb.checked : false,
        customized: tr.getAttribute('data-customized') === '1',
      });
    }
    return out;
  }

  function funnelCounts(rows) {
    var counts = {};
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r.enabled) continue;
      var key = sanitizeLabel(r.label);
      if (!key) continue;
      counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
  }

  function updateSuggestions(rows) {
    if (!suggestList) return;
    var seen = {};
    var opts = [];
    for (var i = 0; i < rows.length; i++) {
      var l = sanitizeLabel(rows[i].label);
      if (!l) continue;
      if (seen[l]) continue;
      seen[l] = true;
      opts.push(l);
    }
    suggestList.innerHTML = opts.map(function (v) {
      return '<option value="' + v.replace(/"/g, '&quot;') + '"></option>';
    }).join('');
  }

  function syncFunnelBadges() {
    var rows = readRows();
    var counts = funnelCounts(rows);
    var trs = tbody ? tbody.querySelectorAll('tr.folder-row') : [];
    var funneled = 0;
    for (var i = 0; i < trs.length; i++) {
      var tr = trs[i];
      var inp = tr.querySelector('.folder-label');
      var key = inp ? sanitizeLabel(inp.value) : '';
      var c = key ? counts[key] || 0 : 0;
      if (c > 1) {
        tr.classList.add('folder-funneled');
        funneled += 1;
      } else {
        tr.classList.remove('folder-funneled');
      }
    }
    if (foldersHint) {
      var enabledCount = 0;
      for (var j = 0; j < rows.length; j++) if (rows[j].enabled) enabledCount += 1;
      var pieces = [];
      pieces.push(enabledCount + ' of ' + rows.length + ' folders will sync');
      if (funneled > 0) pieces.push(funneled + ' rows share a label (funneled)');
      foldersHint.textContent = pieces.join(' -- ');
    }
    updateSuggestions(rows);
  }

  function renderRows(folders) {
    if (!tbody || !rowTpl) return;
    tbody.innerHTML = '';
    var prefix = labelPrefixInput ? labelPrefixInput.value : '';
    for (var i = 0; i < folders.length; i++) {
      var f = folders[i];
      var node = rowTpl.content.firstElementChild.cloneNode(true);
      node.setAttribute('data-path', f.path);
      node.setAttribute('data-customized', f.customized ? '1' : '0');
      var cb = node.querySelector('.folder-sync');
      var pathCell = node.querySelector('.folder-path');
      var labelInp = node.querySelector('.folder-label');
      pathCell.textContent = f.path;
      if (f.specialUse) {
        var sub = document.createElement('div');
        sub.className = 'muted small';
        sub.textContent = f.specialUse;
        pathCell.appendChild(sub);
      }
      cb.checked = f.enabled !== false;
      if (f.path === 'INBOX') {
        cb.checked = true;
        cb.disabled = true;
        cb.title = 'INBOX is required';
      }
      var val = f.label;
      if (!val) val = autoLabelFor(f.path, prefix);
      labelInp.value = val;
      tbody.appendChild(node);
    }
    if (folders.length > 0) {
      if (emptyMsg) emptyMsg.hidden = true;
      if (tableWrap) tableWrap.hidden = false;
    } else {
      if (emptyMsg) emptyMsg.hidden = false;
      if (tableWrap) tableWrap.hidden = true;
    }
    syncFunnelBadges();
    updateSaveState();
  }

  function mergeDiscovered(found) {
    var prior = readRows();
    var priorMap = {};
    for (var i = 0; i < prior.length; i++) priorMap[prior[i].path] = prior[i];
    var merged = [];
    var seen = {};
    for (var j = 0; j < found.length; j++) {
      var f = found[j];
      seen[f.path] = true;
      var old = priorMap[f.path];
      if (old) {
        merged.push({
          path: f.path,
          label: old.label,
          enabled: old.enabled,
          customized: old.customized,
          specialUse: f.specialUse || null,
        });
      } else {
        merged.push({
          path: f.path,
          label: autoLabelFor(f.path, labelPrefixInput ? labelPrefixInput.value : ''),
          enabled: true,
          customized: false,
          specialUse: f.specialUse || null,
        });
      }
    }
    // Preserve INBOX even if server omitted it somehow.
    if (!seen['INBOX']) {
      var inbox = priorMap['INBOX'] || { path: 'INBOX', label: '', enabled: true, customized: false };
      inbox.label = inbox.label || autoLabelFor('INBOX', labelPrefixInput ? labelPrefixInput.value : '');
      merged.unshift({
        path: 'INBOX',
        label: inbox.label,
        enabled: true,
        customized: inbox.customized,
        specialUse: null,
      });
    }
    return merged;
  }

  function validateFolders() {
    if (!isImap()) return { ok: true };
    var rows = readRows();
    if (rows.length === 0) return { ok: false, msg: 'Discover folders before saving' };
    var anyEnabled = false;
    var inbox = null;
    var paths = {};
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (paths[r.path]) return { ok: false, msg: 'Duplicate folder: ' + r.path };
      paths[r.path] = true;
      if (r.path === 'INBOX') inbox = r;
      if (r.enabled) {
        anyEnabled = true;
        if (!sanitizeLabel(r.label)) return { ok: false, msg: 'Missing label for "' + r.path + '"' };
      }
    }
    if (!inbox) return { ok: false, msg: 'INBOX row is required' };
    if (!inbox.enabled) return { ok: false, msg: 'INBOX must be enabled' };
    if (!anyEnabled) return { ok: false, msg: 'Enable at least one folder' };
    return { ok: true };
  }

  function updateSaveState() {
    if (!saveBtn) return;
    if (!isImap()) {
      saveBtn.disabled = false;
      if (saveHint) saveHint.textContent = '';
      return;
    }
    var v = validateFolders();
    if (!v.ok) {
      saveBtn.disabled = true;
      if (saveHint) saveHint.textContent = v.msg;
      return;
    }
    saveBtn.disabled = false;
    if (saveHint) saveHint.textContent = '';
  }

  function serializeBody() {
    var fd = new FormData(form);
    var body = new URLSearchParams();
    fd.forEach(function (v, k) {
      // Skip folders_json here since it's populated on submit.
      if (k === 'folders_json') return;
      body.append(k, typeof v === 'string' ? v : '');
    });
    return body;
  }

  if (testBtn && testOut) {
    testBtn.addEventListener('click', async function () {
      testOut.className = 'muted';
      testOut.textContent = 'Testing...';
      testBtn.disabled = true;
      try {
        var body = serializeBody();
        var res = await fetch('/sources/test', {
          method: 'POST',
          body: body,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          credentials: 'same-origin'
        });
        var data;
        try { data = await res.json(); } catch (_) { data = { ok: false, error: 'unexpected response (HTTP ' + res.status + ')' }; }
        if (data && data.ok) {
          testOut.className = 'ok';
          testOut.textContent = 'Connection OK.';
          testPassed = true;
        } else {
          testOut.className = 'error';
          testOut.textContent = 'Failed: ' + (data && data.error ? data.error : 'unknown error');
          testPassed = false;
        }
      } catch (err) {
        testOut.className = 'error';
        testOut.textContent = 'Network error: ' + (err && err.message ? err.message : err);
        testPassed = false;
      } finally {
        testBtn.disabled = false;
        updateSaveState();
      }
    });
  }

  if (discoverBtn && discoverOut) {
    discoverBtn.addEventListener('click', async function () {
      if (!isImap()) {
        discoverOut.className = 'muted';
        discoverOut.textContent = 'Discovery is only for IMAP.';
        return;
      }
      discoverOut.className = 'muted';
      discoverOut.textContent = 'Contacting server...';
      discoverBtn.disabled = true;
      try {
        var body = serializeBody();
        var res = await fetch('/sources/folders/discover', {
          method: 'POST',
          body: body,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          credentials: 'same-origin'
        });
        var data;
        try { data = await res.json(); } catch (_) { data = { ok: false, error: 'unexpected response (HTTP ' + res.status + ')' }; }
        if (data && data.ok) {
          discoverOut.className = 'ok';
          discoverOut.textContent = 'Found ' + data.folders.length + ' folder(s).';
          var merged = mergeDiscovered(data.folders);
          renderRows(merged);
          hasDiscovered = true;
        } else {
          discoverOut.className = 'error';
          discoverOut.textContent = 'Failed: ' + (data && data.error ? data.error : 'unknown error');
        }
      } catch (err) {
        discoverOut.className = 'error';
        discoverOut.textContent = 'Network error: ' + (err && err.message ? err.message : err);
      } finally {
        discoverBtn.disabled = false;
        updateSaveState();
      }
    });
  }

  if (tbody) {
    tbody.addEventListener('input', function (ev) {
      var t = ev.target;
      if (!t) return;
      if (t.classList.contains('folder-label')) {
        var row = t.closest('tr.folder-row');
        if (row) row.setAttribute('data-customized', '1');
        syncFunnelBadges();
      }
      updateSaveState();
    });
    tbody.addEventListener('change', function (ev) {
      var t = ev.target;
      if (!t) return;
      if (t.classList.contains('folder-sync')) {
        syncFunnelBadges();
      }
      updateSaveState();
    });
  }

  if (labelPrefixInput) {
    labelPrefixInput.addEventListener('input', function () {
      prefixManuallyChanged = true;
      var rows = readRows();
      var prefix = labelPrefixInput.value;
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (r.customized) continue;
        var tr = tbody.querySelector('tr.folder-row[data-path="' + cssEscape(r.path) + '"]');
        if (!tr) continue;
        var inp = tr.querySelector('.folder-label');
        if (inp) inp.value = autoLabelFor(r.path, prefix);
      }
      syncFunnelBadges();
      updateSaveState();
    });
  }

  if (nameInput && labelPrefixInput) {
    nameInput.addEventListener('input', function () {
      if (prefixManuallyChanged) return;
      if (labelPrefixInput.value && labelPrefixInput.value !== nameInput.value) return;
      labelPrefixInput.value = nameInput.value;
      // Re-render uncustomized rows with new prefix.
      var rows = readRows();
      var prefix = labelPrefixInput.value;
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (r.customized) continue;
        var tr = tbody.querySelector('tr.folder-row[data-path="' + cssEscape(r.path) + '"]');
        if (!tr) continue;
        var inp = tr.querySelector('.folder-label');
        if (inp) inp.value = autoLabelFor(r.path, prefix);
      }
      syncFunnelBadges();
      updateSaveState();
    });
  }

  if (typeSel) {
    typeSel.addEventListener('change', updateTypeUi);
  }

  form.addEventListener('submit', function (ev) {
    if (isImap()) {
      var v = validateFolders();
      if (!v.ok) {
        ev.preventDefault();
        if (saveHint) saveHint.textContent = v.msg;
        if (discoverOut && !hasDiscovered) {
          discoverOut.className = 'error';
          discoverOut.textContent = 'Discover folders before saving.';
        }
        return;
      }
    }
    var rows = readRows().map(function (r) {
      return { path: r.path, label: sanitizeLabel(r.label), enabled: r.enabled };
    });
    foldersJsonField.value = isImap() ? JSON.stringify(rows) : '';
  });

  function cssEscape(s) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
    return String(s).replace(/["\\\[\]\(\)\s]/g, function (c) { return '\\' + c; });
  }

  // Initial render.
  if (Array.isArray(initial) && initial.length > 0) {
    var seeded = initial.map(function (r) {
      return {
        path: r.path,
        label: r.label,
        enabled: r.enabled !== false,
        customized: true,
        specialUse: null,
      };
    });
    renderRows(seeded);
  }
  updateTypeUi();
})();
