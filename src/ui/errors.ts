// Only application-authored hints bypass diagnostic redaction.
export class ActionableError extends Error {
  constructor(message: string, readonly hint: string, cause: unknown) {
    super(message, { cause });
  }
}

export function sanitizeError(raw: string): string {
  let s = raw.replace(/\r?\n/g, ' ');
  s = s.replace(/\b(PASS|LOGIN|AUTHENTICATE|AUTH|PLAIN|APOP)\b[^\n]*/gi, '$1 [redacted]');
  s = s.replace(/\b(password|token|bearer|secret)\s*[:=]\s*\S+/gi, '$1=[redacted]');
  if (s.length > 500) s = s.slice(0, 500) + '...';
  return s;
}

export function formatError(err: unknown): string {
  const seen = new Set<unknown>();
  let cause = err;
  while (cause instanceof Error && !seen.has(cause)) {
    seen.add(cause);
    if (cause instanceof ActionableError) {
      // Keep Google's diagnostic even when an import error wraps it. Reserve
      // room for the hint, which includes "Auth Platform" (a redaction keyword).
      const diagnostic = sanitizeError(cause.message);
      const budget = Math.max(0, 500 - cause.hint.length - 2);
      const shortened = diagnostic.length > budget
        ? diagnostic.slice(0, Math.max(0, budget - 3)) + '...'
        : diagnostic;
      return `${shortened}. ${cause.hint}`;
    }
    cause = cause.cause;
  }
  return sanitizeError(err instanceof Error ? err.message : String(err));
}
