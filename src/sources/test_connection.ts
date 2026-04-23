import { ImapFlow } from 'imapflow';

export type TestConnectionArgs = {
  type: 'imap' | 'pop';
  host: string;
  port: number;
  useTls: boolean;
  username: string;
  password: string;
};

export type TestConnectionResult =
  | { ok: true }
  | { ok: false; error: string };

export type DiscoveredFolder = {
  path: string;
  delimiter: string | null;
  specialUse: string | null;
};

export type ListFoldersArgs = Omit<TestConnectionArgs, 'type'>;

export type ListFoldersResult =
  | { ok: true; folders: DiscoveredFolder[] }
  | { ok: false; error: string };

function friendlyError(args: { type: 'imap' | 'pop'; host: string; port: number; useTls: boolean }, raw: string): string {
  const isImap = args.type === 'imap';
  const plaintextPort = isImap ? 143 : 110;
  const tlsPort = isImap ? 993 : 995;
  // "wrong version number" = TLS on a plaintext socket.
  if (/wrong version number|SSL routines|ssl3_record/i.test(raw) && args.useTls) {
    return `TLS handshake failed. Port ${args.port} looks like a plaintext port; try port ${tlsPort} (implicit TLS) or untick "Use TLS" if your server is on ${plaintextPort} without STARTTLS. (${raw})`;
  }
  // Plaintext read of a TLS greeting tends to surface as garbled bytes or a protocol error.
  if (!args.useTls && /^\*|protocol|greeting|illegal|parse/i.test(raw) && args.port === tlsPort) {
    return `Port ${tlsPort} is an implicit-TLS port; tick "Use TLS" or switch to port ${plaintextPort}. (${raw})`;
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(raw)) {
    return `Host "${args.host}" could not be resolved. Check for typos. (${raw})`;
  }
  if (/ECONNREFUSED/i.test(raw)) {
    return `Connection refused on ${args.host}:${args.port}. Is the port open and serving ${args.type}? (${raw})`;
  }
  if (/ETIMEDOUT|Timeout/i.test(raw)) {
    return `Timed out connecting to ${args.host}:${args.port}. Firewall, wrong port, or slow server. (${raw})`;
  }
  if (/authentication failed|auth.+fail|invalid credentials|bad credentials|LOGIN.*fail/i.test(raw)) {
    return `Authentication failed. Username/password is wrong, or the provider requires an app-specific password. (${raw})`;
  }
  return raw;
}

function buildImapClient(a: ListFoldersArgs, timeoutMs: number): ImapFlow {
  const client = new ImapFlow({
    host: a.host,
    port: a.port,
    secure: a.useTls,
    auth: { user: a.username, pass: a.password },
    logger: false,
    socketTimeout: timeoutMs,
    connectionTimeout: timeoutMs,
  });
  // ImapFlow is an EventEmitter; an unhandled 'error' crashes the process.
  client.on('error', () => {});
  return client;
}

async function testImap(a: TestConnectionArgs): Promise<TestConnectionResult> {
  const client = buildImapClient(a, 10_000);
  try {
    await client.connect();
    const box = await client.mailboxOpen('INBOX', { readOnly: true });
    await client.mailboxClose();
    void box;
    return { ok: true };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    return { ok: false, error: friendlyError(a, raw) };
  } finally {
    try {
      await client.logout();
    } catch {
      // best effort
    }
  }
}

async function testPop(a: TestConnectionArgs): Promise<TestConnectionResult> {
  const mod = await import('node-pop3');
  const Pop3 = (mod as unknown as { default: new (o: Record<string, unknown>) => { _connect: () => Promise<unknown>; QUIT: () => Promise<unknown> } }).default;
  const client = new Pop3({
    host: a.host,
    port: a.port,
    tls: a.useTls,
    user: a.username,
    password: a.password,
    timeout: 10_000,
  });
  try {
    await client._connect();
    return { ok: true };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    return { ok: false, error: friendlyError(a, raw) };
  } finally {
    try {
      await client.QUIT();
    } catch {
      // best effort
    }
  }
}

export async function testConnection(a: TestConnectionArgs): Promise<TestConnectionResult> {
  return a.type === 'imap' ? testImap(a) : testPop(a);
}

// Special-use flags we never want to sync. \All re-fetches INBOX contents.
const SKIP_SPECIAL_USE = new Set([
  '\\Sent',
  '\\Drafts',
  '\\Trash',
  '\\Junk',
  '\\All',
  '\\Archive',
  '\\Flagged',
  '\\Important',
]);

type ImapFlowMailbox = {
  path?: string;
  delimiter?: string;
  specialUse?: string | null;
  flags?: Iterable<string> | Set<string>;
  subscribed?: boolean;
};

function hasFlag(flags: ImapFlowMailbox['flags'], name: string): boolean {
  if (!flags) return false;
  if (flags instanceof Set) return flags.has(name);
  for (const f of flags) if (f === name) return true;
  return false;
}

export async function listImapFolders(a: ListFoldersArgs): Promise<ListFoldersResult> {
  const client = buildImapClient(a, 15_000);
  try {
    await client.connect();
    const boxes = (await client.list()) as ImapFlowMailbox[];
    const out: DiscoveredFolder[] = [];
    for (const m of boxes) {
      if (!m.path) continue;
      if (hasFlag(m.flags, '\\Noselect') || hasFlag(m.flags, '\\NonExistent')) continue;
      const su = m.specialUse ?? null;
      if (su && SKIP_SPECIAL_USE.has(su) && m.path !== 'INBOX') continue;
      out.push({
        path: m.path,
        delimiter: m.delimiter ?? null,
        specialUse: su,
      });
    }
    // Ensure INBOX comes first; otherwise preserve server order.
    out.sort((x, y) => {
      if (x.path === 'INBOX' && y.path !== 'INBOX') return -1;
      if (y.path === 'INBOX' && x.path !== 'INBOX') return 1;
      return 0;
    });
    // Defensive cap: a hostile/misconfigured server could advertise tens of
    // thousands of mailboxes. The form validation caps mapping at 100 anyway.
    const MAX_DISCOVERED = 500;
    const trimmed = out.length > MAX_DISCOVERED ? out.slice(0, MAX_DISCOVERED) : out;
    return { ok: true, folders: trimmed };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    return { ok: false, error: friendlyError({ ...a, type: 'imap' }, raw) };
  } finally {
    try {
      await client.logout();
    } catch {
      // best effort
    }
  }
}
