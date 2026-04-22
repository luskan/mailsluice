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

function friendlyError(args: TestConnectionArgs, raw: string): string {
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

async function testImap(a: TestConnectionArgs): Promise<TestConnectionResult> {
  const client = new ImapFlow({
    host: a.host,
    port: a.port,
    secure: a.useTls,
    auth: { user: a.username, pass: a.password },
    logger: false,
    socketTimeout: 10_000,
    connectionTimeout: 10_000,
  });
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
