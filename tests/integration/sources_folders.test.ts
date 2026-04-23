import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword } from '../../src/auth/hash.ts';
import { closeTestApp, makeTestApp } from '../helpers/app.ts';
import { seedDestination, seedSource } from '../helpers/seed.ts';
import type Database from 'better-sqlite3';

async function seedUser(
  db: Database.Database,
  username: string,
  password: string,
  isAdmin = false,
): Promise<number> {
  const hash = await hashPassword(password);
  const r = db
    .prepare(
      'INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?) RETURNING id',
    )
    .get(username, hash, isAdmin ? 1 : 0) as { id: number };
  return r.id;
}

function pickCookie(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const raw = headers['set-cookie'];
  if (!raw) return undefined;
  const list = Array.isArray(raw) ? raw : [raw];
  for (const line of list) {
    const m = new RegExp(`^${name}=([^;]+)`).exec(line);
    if (m) return `${name}=${m[1]}`;
  }
  return undefined;
}

async function loginAs(
  app: Awaited<ReturnType<typeof makeTestApp>>['app'],
  username: string,
  password: string,
): Promise<{ cookie: string; csrf: string }> {
  const get = await app.inject({ method: 'GET', url: '/login' });
  const preCookie = pickCookie(get.headers, 'mailsluice.sid')!;
  const preCsrf = /name="_csrf" value="([^"]+)"/.exec(get.body)?.[1]!;
  const post = await app.inject({
    method: 'POST',
    url: '/login',
    headers: { cookie: preCookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: `_csrf=${encodeURIComponent(preCsrf)}&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
  });
  const cookie = pickCookie(post.headers, 'mailsluice.sid')!;
  const home = await app.inject({
    method: 'GET',
    url: '/sources',
    headers: { cookie, accept: 'text/html' },
  });
  const csrf = /name="_csrf" value="([^"]+)"/.exec(home.body)?.[1]!;
  return { cookie, csrf };
}

test('POST /sources/folders/discover without CSRF is rejected', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'u', 'pw');
    const { cookie } = await loginAs(ctx.app, 'u', 'pw');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sources/folders/discover',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'a=1',
    });
    assert.equal(res.statusCode, 403);
  } finally {
    await closeTestApp(ctx);
  }
});

test('POST /sources/folders/discover rejects POP', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'u', 'pw');
    const { cookie, csrf } = await loginAs(ctx.app, 'u', 'pw');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sources/folders/discover',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        _csrf: csrf,
        type: 'pop',
        host: 'x',
        port: '995',
        use_tls: '1',
        username: 'me',
        password: 'pw',
      }).toString(),
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { ok: boolean; error?: string };
    assert.equal(body.ok, false);
    assert.match(body.error ?? '', /imap/i);
  } finally {
    await closeTestApp(ctx);
  }
});

test('POST /sources/folders/discover returns folders from stubbed listImapFolders', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'u', 'pw');
    ctx.app.listImapFolders = async () => ({
      ok: true,
      folders: [
        { path: 'INBOX', delimiter: '/', specialUse: null },
        { path: 'Archive', delimiter: '/', specialUse: null },
        { path: 'Work', delimiter: '/', specialUse: null },
      ],
    });
    const { cookie, csrf } = await loginAs(ctx.app, 'u', 'pw');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sources/folders/discover',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        _csrf: csrf,
        type: 'imap',
        host: 'imap.x',
        port: '993',
        use_tls: '1',
        username: 'me',
        password: 'pw',
      }).toString(),
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { ok: boolean; folders?: unknown };
    assert.equal(body.ok, true);
    assert.deepEqual(body.folders, [
      { path: 'INBOX', delimiter: '/', specialUse: null },
      { path: 'Archive', delimiter: '/', specialUse: null },
      { path: 'Work', delimiter: '/', specialUse: null },
    ]);
  } finally {
    await closeTestApp(ctx);
  }
});

test('POST /sources/folders/discover requires a password for new sources', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'u', 'pw');
    const { cookie, csrf } = await loginAs(ctx.app, 'u', 'pw');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sources/folders/discover',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        _csrf: csrf,
        type: 'imap',
        host: 'imap.x',
        port: '993',
        use_tls: '1',
        username: 'me',
      }).toString(),
    });
    const body = JSON.parse(res.body) as { ok: boolean; error?: string };
    assert.equal(body.ok, false);
    assert.match(body.error ?? '', /password/i);
  } finally {
    await closeTestApp(ctx);
  }
});

test('create IMAP source persists folder mapping', async () => {
  const ctx = await makeTestApp();
  try {
    const uid = await seedUser(ctx.db, 'u', 'pw');
    const did = seedDestination(ctx.db, uid, ctx.cfg.encryptionKeys);
    const { cookie, csrf } = await loginAs(ctx.app, 'u', 'pw');
    const folders = JSON.stringify([
      { path: 'INBOX', label: 'Ext', enabled: true },
      { path: 'Work', label: 'Ext/Work', enabled: true },
      { path: 'Clients', label: 'Ext/Work', enabled: true },
      { path: 'Spam', label: 'Ext/Spam', enabled: false },
    ]);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sources',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        _csrf: csrf,
        name: 'fm',
        type: 'imap',
        host: 'imap.x',
        port: '993',
        use_tls: '1',
        username: 'me',
        password: 'pw',
        destination_id: String(did),
        destination_tag: 'Ext',
        folders_json: folders,
        post_import_action: 'mark_read',
      }).toString(),
    });
    assert.equal(res.statusCode, 302);
    const srcRows = ctx.db.prepare('SELECT id, post_import_action FROM sources').all() as Array<{ id: number; post_import_action: string }>;
    assert.equal(srcRows.length, 1);
    assert.equal(srcRows[0]!.post_import_action, 'mark_read');
    const folderRows = ctx.db
      .prepare('SELECT folder_path, label_name, enabled FROM source_folders WHERE source_id = ? ORDER BY folder_path')
      .all(srcRows[0]!.id) as Array<{ folder_path: string; label_name: string; enabled: number }>;
    assert.equal(folderRows.length, 4);
    const byPath: Record<string, { label_name: string; enabled: number }> = {};
    for (const r of folderRows) byPath[r.folder_path] = { label_name: r.label_name, enabled: r.enabled };
    assert.equal(byPath['INBOX']!.enabled, 1);
    assert.equal(byPath['INBOX']!.label_name, 'Ext');
    assert.equal(byPath['Work']!.label_name, 'Ext/Work');
    assert.equal(byPath['Clients']!.label_name, 'Ext/Work');
    assert.equal(byPath['Spam']!.enabled, 0);
  } finally {
    await closeTestApp(ctx);
  }
});

test('create IMAP source rejects missing folder mapping', async () => {
  const ctx = await makeTestApp();
  try {
    const uid = await seedUser(ctx.db, 'u', 'pw');
    const did = seedDestination(ctx.db, uid, ctx.cfg.encryptionKeys);
    const { cookie, csrf } = await loginAs(ctx.app, 'u', 'pw');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sources',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        _csrf: csrf,
        name: 'fm',
        type: 'imap',
        host: 'imap.x',
        port: '993',
        use_tls: '1',
        username: 'me',
        password: 'pw',
        destination_id: String(did),
        destination_tag: 'Ext',
        // no folders_json
      }).toString(),
    });
    assert.equal(res.statusCode, 302);
    const srcRows = ctx.db.prepare('SELECT id FROM sources').all() as Array<{ id: number }>;
    assert.equal(srcRows.length, 0);
  } finally {
    await closeTestApp(ctx);
  }
});

test('create IMAP source rejects mapping without INBOX', async () => {
  const ctx = await makeTestApp();
  try {
    const uid = await seedUser(ctx.db, 'u', 'pw');
    const did = seedDestination(ctx.db, uid, ctx.cfg.encryptionKeys);
    const { cookie, csrf } = await loginAs(ctx.app, 'u', 'pw');
    const folders = JSON.stringify([
      { path: 'Work', label: 'Ext/Work', enabled: true },
    ]);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sources',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        _csrf: csrf,
        name: 'fm',
        type: 'imap',
        host: 'imap.x',
        port: '993',
        use_tls: '1',
        username: 'me',
        password: 'pw',
        destination_id: String(did),
        destination_tag: 'Ext',
        folders_json: folders,
      }).toString(),
    });
    assert.equal(res.statusCode, 302);
    const srcRows = ctx.db.prepare('SELECT id FROM sources').all() as Array<{ id: number }>;
    assert.equal(srcRows.length, 0);
  } finally {
    await closeTestApp(ctx);
  }
});

test('POP source still works without folders_json', async () => {
  const ctx = await makeTestApp();
  try {
    const uid = await seedUser(ctx.db, 'u', 'pw');
    const did = seedDestination(ctx.db, uid, ctx.cfg.encryptionKeys);
    const { cookie, csrf } = await loginAs(ctx.app, 'u', 'pw');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sources',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        _csrf: csrf,
        name: 'pop',
        type: 'pop',
        host: 'pop.x',
        port: '995',
        use_tls: '1',
        username: 'me',
        password: 'pw',
        destination_id: String(did),
        destination_tag: 'Ext',
        poll_interval_seconds: '600',
      }).toString(),
    });
    assert.equal(res.statusCode, 302);
    const srcRows = ctx.db.prepare('SELECT id FROM sources').all() as Array<{ id: number }>;
    assert.equal(srcRows.length, 1);
    const folderRows = ctx.db.prepare('SELECT COUNT(*) AS n FROM source_folders').get() as { n: number };
    assert.equal(folderRows.n, 0);
  } finally {
    await closeTestApp(ctx);
  }
});

test('edit IMAP source preserves UID cursor on rename', async () => {
  const ctx = await makeTestApp();
  try {
    const uid = await seedUser(ctx.db, 'u', 'pw');
    const did = seedDestination(ctx.db, uid, ctx.cfg.encryptionKeys);
    const srcId = seedSource(ctx.db, {
      userId: uid,
      destinationId: did,
      keys: ctx.cfg.encryptionKeys,
      type: 'imap',
      host: 'imap.x',
      port: 993,
      destinationTag: 'Ext',
      pollIntervalSeconds: null,
    });
    ctx.db.prepare(
      "INSERT INTO source_folders (source_id, folder_path, label_name, enabled, uidvalidity, last_uid, updated_at) VALUES (?, 'INBOX', 'Ext', 1, 100, 42, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
    ).run(srcId);
    ctx.db.prepare(
      "INSERT INTO source_folders (source_id, folder_path, label_name, enabled, uidvalidity, last_uid, updated_at) VALUES (?, 'Work', 'Ext/Work', 1, 200, 17, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
    ).run(srcId);
    const { cookie, csrf } = await loginAs(ctx.app, 'u', 'pw');
    const folders = JSON.stringify([
      { path: 'INBOX', label: 'Ext', enabled: true },
      { path: 'Work', label: 'Ext/WorkRenamed', enabled: true },
    ]);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/sources/${srcId}`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        _csrf: csrf,
        name: 'fm',
        type: 'imap',
        host: 'imap.x',
        port: '993',
        use_tls: '1',
        username: 'u',
        destination_id: String(did),
        destination_tag: 'Ext',
        folders_json: folders,
      }).toString(),
    });
    assert.equal(res.statusCode, 302);
    const rows = ctx.db
      .prepare('SELECT folder_path, label_name, uidvalidity, last_uid FROM source_folders WHERE source_id = ? ORDER BY folder_path')
      .all(srcId) as Array<{ folder_path: string; label_name: string; uidvalidity: number; last_uid: number }>;
    assert.equal(rows.length, 2);
    const byPath: Record<string, { label_name: string; uidvalidity: number; last_uid: number }> = {};
    for (const r of rows) byPath[r.folder_path] = { label_name: r.label_name, uidvalidity: r.uidvalidity, last_uid: r.last_uid };
    assert.equal(byPath['INBOX']!.last_uid, 42);
    assert.equal(byPath['INBOX']!.uidvalidity, 100);
    assert.equal(byPath['Work']!.label_name, 'Ext/WorkRenamed');
    assert.equal(byPath['Work']!.last_uid, 17);
    assert.equal(byPath['Work']!.uidvalidity, 200);
  } finally {
    await closeTestApp(ctx);
  }
});

test('label with </script> in initial render is escaped', async () => {
  const ctx = await makeTestApp();
  try {
    const uid = await seedUser(ctx.db, 'u', 'pw');
    const did = seedDestination(ctx.db, uid, ctx.cfg.encryptionKeys);
    const srcId = seedSource(ctx.db, {
      userId: uid,
      destinationId: did,
      keys: ctx.cfg.encryptionKeys,
      type: 'imap',
      destinationTag: 'Ext',
      pollIntervalSeconds: null,
    });
    const payload = '</script><img src=x onerror=alert(1)>';
    ctx.db.prepare(
      "INSERT INTO source_folders (source_id, folder_path, label_name, enabled) VALUES (?, 'INBOX', ?, 1)",
    ).run(srcId, payload);
    const { cookie } = await loginAs(ctx.app, 'u', 'pw');
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/sources/${srcId}`,
      headers: { cookie, accept: 'text/html' },
    });
    assert.equal(res.statusCode, 200);
    // The raw `</script>` must not appear in the rendered HTML (the JSON block
    // escapes `<` to <, breaking the closing-tag parse).
    assert.ok(!res.body.includes(payload), 'raw payload must not appear verbatim');
    assert.ok(res.body.includes('\\u003c'), 'escaped form expected');
  } finally {
    await closeTestApp(ctx);
  }
});

test('folder path with control characters is rejected', async () => {
  const ctx = await makeTestApp();
  try {
    const uid = await seedUser(ctx.db, 'u', 'pw');
    const did = seedDestination(ctx.db, uid, ctx.cfg.encryptionKeys);
    const { cookie, csrf } = await loginAs(ctx.app, 'u', 'pw');
    const folders = JSON.stringify([
      { path: 'INBOX', label: 'Ext', enabled: true },
      { path: 'Work' + String.fromCharCode(0) + 'bad', label: 'Ext/Work', enabled: true },
    ]);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sources',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        _csrf: csrf,
        name: 'fm',
        type: 'imap',
        host: 'imap.x',
        port: '993',
        use_tls: '1',
        username: 'me',
        password: 'pw',
        destination_id: String(did),
        destination_tag: 'Ext',
        folders_json: folders,
      }).toString(),
    });
    assert.equal(res.statusCode, 302);
    const srcRows = ctx.db.prepare('SELECT id FROM sources').all() as Array<{ id: number }>;
    assert.equal(srcRows.length, 0);
  } finally {
    await closeTestApp(ctx);
  }
});

test('edit IMAP source drops removed folder', async () => {
  const ctx = await makeTestApp();
  try {
    const uid = await seedUser(ctx.db, 'u', 'pw');
    const did = seedDestination(ctx.db, uid, ctx.cfg.encryptionKeys);
    const srcId = seedSource(ctx.db, {
      userId: uid,
      destinationId: did,
      keys: ctx.cfg.encryptionKeys,
      type: 'imap',
      destinationTag: 'Ext',
      pollIntervalSeconds: null,
    });
    ctx.db.prepare(
      "INSERT INTO source_folders (source_id, folder_path, label_name, enabled, uidvalidity, last_uid, updated_at) VALUES (?, 'INBOX', 'Ext', 1, 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
    ).run(srcId);
    ctx.db.prepare(
      "INSERT INTO source_folders (source_id, folder_path, label_name, enabled, uidvalidity, last_uid, updated_at) VALUES (?, 'Gone', 'Ext/Gone', 1, 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
    ).run(srcId);
    const { cookie, csrf } = await loginAs(ctx.app, 'u', 'pw');
    const folders = JSON.stringify([
      { path: 'INBOX', label: 'Ext', enabled: true },
    ]);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/sources/${srcId}`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        _csrf: csrf,
        name: 'fm',
        type: 'imap',
        host: 'imap.x',
        port: '993',
        use_tls: '1',
        username: 'u',
        destination_id: String(did),
        destination_tag: 'Ext',
        folders_json: folders,
      }).toString(),
    });
    assert.equal(res.statusCode, 302);
    const rows = ctx.db
      .prepare('SELECT folder_path FROM source_folders WHERE source_id = ?')
      .all(srcId) as Array<{ folder_path: string }>;
    assert.deepEqual(rows.map((r) => r.folder_path).sort(), ['INBOX']);
  } finally {
    await closeTestApp(ctx);
  }
});
