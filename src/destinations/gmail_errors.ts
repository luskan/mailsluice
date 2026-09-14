import { ActionableError } from '../ui/errors.ts';

const REFRESH_HINT = 'Google rejected the refresh token. One common cause is an OAuth app left in Testing, where Gmail authorizations expire after 7 days. Check Google Auth Platform → Audience: for long-running use it should say In production, then use Reconnect in Mailsluice. Tokens can also be revoked or invalidated for other reasons.';

// Call only for an established Gmail destination's refresh/API operations,
// never for authorization-code exchange (where invalid_grant means something else).
export function rethrowGmailRefreshError(err: unknown): never {
  if (err instanceof ActionableError) throw err;
  const data = (err as { response?: { data?: { error?: unknown; error_description?: unknown } } } | null)?.response?.data;
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const description = typeof data?.error_description === 'string' ? data.error_description : '';
  if (data?.error === 'invalid_grant' || /\binvalid_grant\b/i.test(message)
    || /token has been expired or revoked/i.test(`${message} ${description}`)) {
    const diagnostic = [data?.error === 'invalid_grant' ? 'invalid_grant' : '', message, description]
      .filter((value, i, all) => value && all.indexOf(value) === i).join(': ');
    throw new ActionableError(diagnostic, REFRESH_HINT, err);
  }
  throw err;
}
