import { OAuth2Client, type Credentials } from 'google-auth-library';
import { gmail, type gmail_v1 } from '@googleapis/gmail';
import type {
  AuthStarter,
  Destination,
  DestinationFactory,
  ImportOptions,
  ProbeResult,
} from './types.ts';

export type GmailAdminConfig = {
  client_id: string;
  client_secret: string;
  redirect_uri?: string;
};

export type GmailUserCredentials = Credentials & {
  email_address?: string;
};

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.labels',
  'https://www.googleapis.com/auth/userinfo.email',
];

export class ScopeInsufficientError extends Error {}
export class OAuthConfigMissingError extends Error {}

function buildOAuthClient(admin: GmailAdminConfig, redirectUri: string): OAuth2Client {
  return new OAuth2Client({
    clientId: admin.client_id,
    clientSecret: admin.client_secret,
    redirectUri,
  });
}

function scopesCover(granted: string | undefined, required: string[]): boolean {
  if (!granted) return false;
  const got = new Set(granted.split(/\s+/).filter(Boolean));
  return required.every((s) => got.has(s));
}

class GmailAuthStarter implements AuthStarter {
  readonly type = 'gmail';
  private readonly admin: GmailAdminConfig;
  private readonly redirectUri: string;

  constructor(admin: GmailAdminConfig, redirectUri: string) {
    this.admin = admin;
    this.redirectUri = redirectUri;
  }

  authUrl(state: string): string {
    const client = buildOAuthClient(this.admin, this.redirectUri);
    return client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: SCOPES,
      state,
      include_granted_scopes: true,
    });
  }

  async handleCallback(params: URLSearchParams): Promise<{
    userCredentials: GmailUserCredentials;
    accountIdentifier: string;
  }> {
    const code = params.get('code');
    if (!code) throw new Error('missing authorization code');

    const client = buildOAuthClient(this.admin, this.redirectUri);
    const { tokens } = await client.getToken(code);

    if (!scopesCover(tokens.scope, SCOPES)) {
      throw new ScopeInsufficientError(
        `granted scopes do not include required: ${SCOPES.join(' ')}`,
      );
    }
    if (!tokens.refresh_token) {
      throw new Error(
        'no refresh_token returned; revoke existing authorization and try again',
      );
    }

    client.setCredentials(tokens);
    const api = gmail({ version: 'v1', auth: client });
    const profile = await api.users.getProfile({ userId: 'me' });
    const email = profile.data.emailAddress ?? '';

    return {
      userCredentials: { ...tokens, email_address: email },
      accountIdentifier: email,
    };
  }
}

class GmailDestination implements Destination {
  readonly type = 'gmail';
  private readonly client: OAuth2Client;
  private readonly api: gmail_v1.Gmail;
  private readonly labelCache = new Map<string, string>();
  private refreshInFlight: Promise<string | null | undefined> | null = null;
  private readonly onCredentialsRefreshed?: (creds: GmailUserCredentials) => void;
  private cachedEmail: string | undefined;

  constructor(
    admin: GmailAdminConfig,
    userCreds: GmailUserCredentials,
    onRefresh?: (creds: GmailUserCredentials) => void,
  ) {
    this.client = new OAuth2Client({
      clientId: admin.client_id,
      clientSecret: admin.client_secret,
    });
    this.client.setCredentials(userCreds);
    this.cachedEmail = userCreds.email_address;
    if (onRefresh) this.onCredentialsRefreshed = onRefresh;

    this.client.on('tokens', (tokens) => {
      const merged: GmailUserCredentials = {
        ...(this.client.credentials as Credentials),
        ...tokens,
      };
      if (this.cachedEmail) merged.email_address = this.cachedEmail;
      this.onCredentialsRefreshed?.(merged);
    });

    this.api = gmail({ version: 'v1', auth: this.client });
  }

  async ensureValidToken(): Promise<void> {
    if (this.refreshInFlight) {
      await this.refreshInFlight;
      return;
    }
    const p = this.client.getAccessToken().then((r) => r.token);
    this.refreshInFlight = p;
    try {
      await p;
    } finally {
      // Clear on the microtask queue so a concurrent awaiter that resumes
      // inside `await this.refreshInFlight` sees the same in-flight promise.
      queueMicrotask(() => {
        if (this.refreshInFlight === p) this.refreshInFlight = null;
      });
    }
  }

  private readonly pendingLabelCreates = new Map<string, Promise<string>>();

  async ensureTag(name: string): Promise<string> {
    const key = normalizeLabelKey(name);
    const cached = this.labelCache.get(key);
    if (cached) return cached;
    const pending = this.pendingLabelCreates.get(key);
    if (pending) return pending;

    const p = this.doEnsureTag(name).finally(() => {
      queueMicrotask(() => {
        if (this.pendingLabelCreates.get(key) === p) {
          this.pendingLabelCreates.delete(key);
        }
      });
    });
    this.pendingLabelCreates.set(key, p);
    return p;
  }

  private async doEnsureTag(name: string): Promise<string> {
    await this.ensureValidToken();
    const key = normalizeLabelKey(name);
    const existing = await this.api.users.labels.list({ userId: 'me' });
    // Gmail treats label names as case-insensitive for uniqueness, so match
    // the same way when looking up existing labels; otherwise we'd try to
    // create a label that Gmail will reject with "Label name exists or
    // conflicts". We also NFC-normalize and trim because Gmail's server-side
    // uniqueness check appears to do the same.
    const hit = findLabelByNameCI(existing.data.labels, name);
    if (hit?.id) {
      this.labelCache.set(key, hit.id);
      return hit.id;
    }
    try {
      const created = await this.api.users.labels.create({
        userId: 'me',
        requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
      });
      const id = created.data.id;
      if (!id) throw new Error('label creation returned no id');
      this.labelCache.set(key, id);
      return id;
    } catch (err) {
      const status = extractHttpStatus(err);
      if (status !== 409 && status !== 400) throw err;
      // Either a concurrent actor created the same label, or the name
      // collides with an existing one under a different casing. Re-list
      // and pick it up (case-insensitively).
      const retry = await this.api.users.labels.list({ userId: 'me' });
      const got = findLabelByNameCI(retry.data.labels, name);
      if (got?.id) {
        this.labelCache.set(key, got.id);
        return got.id;
      }
      const raw = err instanceof Error ? err.message : String(err);
      const wrapped = new Error(
        `Gmail rejected label "${name}" (${raw}). It likely collides with a reserved name; pick a different one.`,
        { cause: err },
      );
      throw wrapped;
    }
  }

  async importMessage(
    raw: Buffer,
    tagId: string,
    _originalDate: Date,
    options?: ImportOptions,
  ): Promise<string> {
    await this.ensureValidToken();
    const { Readable } = await import('node:stream');
    // Since Gmail's Jan 2015 change, import no longer auto-applies INBOX or
    // UNREAD. We add both (mirroring normal delivery) and skip UNREAD when
    // the source had the message already read. INBOX is always present so
    // the user's filters and notifications fire the same way they would on
    // fresh mail.
    const labelIds = [tagId, 'INBOX'];
    if (!options?.alreadySeen) labelIds.push('UNREAD');
    const res = await this.api.users.messages.import({
      userId: 'me',
      internalDateSource: 'dateHeader',
      neverMarkSpam: false,
      processForCalendar: false,
      requestBody: { labelIds },
      media: { mimeType: 'message/rfc822', body: Readable.from(raw) },
    });
    const id = res.data.id;
    if (!id) throw new Error('import returned no message id');
    return id;
  }

  async probe(): Promise<ProbeResult> {
    try {
      await this.ensureValidToken();
      const res = await this.api.users.getProfile({ userId: 'me' });
      const email = res.data.emailAddress ?? '';
      this.cachedEmail = email;
      return { ok: true, email };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

export const GmailFactory: DestinationFactory = {
  type: 'gmail',
  createAuthStarter({ adminConfig, redirectUri }) {
    const admin = adminConfig as GmailAdminConfig;
    if (!admin?.client_id || !admin.client_secret) {
      throw new OAuthConfigMissingError('gmail admin config not set');
    }
    return new GmailAuthStarter(admin, redirectUri);
  },
  createDestination({ adminConfig, userCredentials, onCredentialsRefreshed }) {
    const admin = adminConfig as GmailAdminConfig;
    if (!admin?.client_id || !admin.client_secret) {
      throw new OAuthConfigMissingError('gmail admin config not set');
    }
    const opts: ConstructorParameters<typeof GmailDestination>[2] = onCredentialsRefreshed
      ? (creds) => onCredentialsRefreshed(creds)
      : undefined;
    return new GmailDestination(
      admin,
      userCredentials as GmailUserCredentials,
      opts,
    );
  },
};

function normalizeLabelKey(name: string): string {
  // Gmail compares label names server-side after NFC + whitespace
  // normalization. Do the same so list-then-match behaves deterministically
  // for inputs like "Work ", "Work/Clients", "Cáfe" vs "Café".
  // toLowerCase without a locale is correct here; toLocaleLowerCase would
  // mishandle Turkish I.
  return name.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function findLabelByNameCI(
  labels: gmail_v1.Schema$Label[] | undefined,
  name: string,
): gmail_v1.Schema$Label | undefined {
  if (!labels) return undefined;
  const want = normalizeLabelKey(name);
  return labels.find(
    (l) => typeof l.name === 'string' && normalizeLabelKey(l.name) === want && l.id,
  );
}

function extractHttpStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  const candidates = [e.code, e.status, e.response?.status];
  for (const c of candidates) {
    if (typeof c === 'number') return c;
    if (typeof c === 'string' && /^\d+$/.test(c)) return Number(c);
  }
  return undefined;
}

export { GmailDestination, GmailAuthStarter, SCOPES as GMAIL_SCOPES };
