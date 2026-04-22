// Subset of SecLists/Common-Credentials, lowercased for case-insensitive match.
const COMMON_PASSWORDS = new Set<string>([
  '123456', '123456789', 'qwerty', 'password', '12345', '12345678', '111111',
  '1234567', '1234567890', '123123', '000000', 'iloveyou', '1234', 'abc123',
  'qwerty123', 'password1', 'password123', 'admin', 'welcome', 'login',
  'princess', 'qwertyuiop', 'solo', 'passw0rd', 'starwars', 'baseball', 'monkey',
  'letmein', 'dragon', 'master', 'sunshine', 'ashley', 'bailey', 'shadow',
  'superman', 'qazwsx', 'michael', 'football', 'charlie', 'donald', 'jessica',
  'trustno1', 'hunter', 'hunter2', 'freedom', 'whatever', 'querty', 'zaq1zaq1',
  '1q2w3e4r', 'q1w2e3r4', '1qaz2wsx', 'asdfghjkl', 'asdasd', '654321',
  '121212', '112233', '159753', '696969', 'secret', 'soccer', 'pokemon',
  'batman', 'andrew', 'tigger', 'computer', 'michelle', 'jordan', 'robert',
  'daniel', 'thomas', 'thunder', 'killer', 'access', 'love', 'jesus',
  'ninja', 'mustang', 'harley', 'ranger', 'buster', 'maggie', 'summer',
  'jordan23', 'heather', 'hannah', 'amanda', 'ginger', 'joshua', 'mailsluice',
  'mailsluice1', 'mailsluice123', 'changeme', 'changeme1', 'default', 'guest',
  'user', 'user1', 'test', 'test1', 'test123', 'testing', 'demo', 'temp',
  'welcome1', 'welcome123', 'letmein1', 'letmein123', 'p@ssword', 'p@ssw0rd',
  'p@ssword1', 'p@ssw0rd1', 'password!', 'password1!', 'password12',
  'passw0rd1', 'admin1', 'admin123', 'administrator', 'root', 'toor',
  'qwerty1', 'qwerty12', 'qwerty!',
]);

export const MIN_LENGTH = 12;
export const MAX_LENGTH = 128;

export type PolicyOk = { ok: true };
export type PolicyFail = { ok: false; error: string };
export type PolicyResult = PolicyOk | PolicyFail;

export type PolicyContext = {
  username?: string;
  currentPassword?: string;
};

export function checkPasswordPolicy(
  password: string,
  ctx: PolicyContext = {},
): PolicyResult {
  if (password.length < MIN_LENGTH) {
    return { ok: false, error: `Password must be at least ${MIN_LENGTH} characters.` };
  }
  if (password.length > MAX_LENGTH) {
    return { ok: false, error: `Password must be at most ${MAX_LENGTH} characters.` };
  }
  if (ctx.username && password.toLowerCase() === ctx.username.toLowerCase()) {
    return { ok: false, error: 'Password must not match your username.' };
  }
  if (ctx.currentPassword && password === ctx.currentPassword) {
    return { ok: false, error: 'New password must differ from the current one.' };
  }
  if (/^(.)\1+$/.test(password)) {
    return { ok: false, error: 'Password is too repetitive.' };
  }
  const normalized = password.trim().toLowerCase();
  if (COMMON_PASSWORDS.has(normalized)) {
    return { ok: false, error: 'That password appears in common-password lists. Pick something less guessable.' };
  }
  // Common-word + short suffix shape (password1234, qwerty123456).
  if (
    /^(password|qwerty|letmein|changeme|welcome|iloveyou|secret|admin|mailsluice|monkey|dragon|master|sunshine|football|princess|trustno1|default|guest|abc123|abcdef|asdfghjkl|qwertyuiop|p@ssword|p@ssw0rd)[\s!@#$%^&*_\-+=.]*\d{0,8}[!@#$%^&*_\-+=.]*$/i.test(
      password,
    )
  ) {
    return { ok: false, error: 'That password is a common word plus a short suffix. Pick something less guessable.' };
  }
  if (/^\d+$/.test(password)) {
    return { ok: false, error: 'All-digit passwords are too easily guessed.' };
  }
  return { ok: true };
}

export function estimatedCharsetNote(password: string): string {
  const hasLower = /[a-z]/.test(password);
  const hasUpper = /[A-Z]/.test(password);
  const hasDigit = /\d/.test(password);
  const hasSymbol = /[^A-Za-z0-9\s]/.test(password);
  const classes = [hasLower, hasUpper, hasDigit, hasSymbol].filter(Boolean).length;
  if (classes >= 3) return 'ok';
  if (password.length >= 20) return 'ok-long';
  return 'weak-variety';
}
