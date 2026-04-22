(function () {
  var form = document.getElementById('source-form');
  var btn = document.getElementById('test-btn');
  var out = document.getElementById('test-result');
  if (!form || !btn || !out) return;

  btn.addEventListener('click', async function () {
    out.className = 'muted';
    out.textContent = 'Testing...';
    btn.disabled = true;
    try {
      var fd = new FormData(form);
      var body = new URLSearchParams();
      fd.forEach(function (v, k) { body.append(k, String(v)); });
      var res = await fetch('/sources/test', {
        method: 'POST',
        body: body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        credentials: 'same-origin'
      });
      var data;
      try { data = await res.json(); } catch (_) { data = { ok: false, error: 'unexpected response (HTTP ' + res.status + ')' }; }
      if (data && data.ok) {
        out.className = 'ok';
        out.textContent = 'Connection OK.';
      } else {
        out.className = 'error';
        out.textContent = 'Failed: ' + (data && data.error ? data.error : 'unknown error');
      }
    } catch (err) {
      out.className = 'error';
      out.textContent = 'Network error: ' + (err && err.message ? err.message : err);
    } finally {
      btn.disabled = false;
    }
  });
})();
