export type Clock = {
  now(): number;
  setTimeout(handler: () => void, ms: number): { clear: () => void };
};

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout(handler, ms) {
    const t = setTimeout(handler, ms);
    return { clear: () => clearTimeout(t) };
  },
};

export type BackoffOpts = {
  baseMs: number;
  maxMs: number;
  factor?: number;
};

export class Backoff {
  private readonly opts: Required<BackoffOpts>;
  private attempts = 0;

  constructor(opts: BackoffOpts) {
    this.opts = { factor: 2, ...opts };
  }

  nextDelayMs(): number {
    const exp = Math.min(
      this.opts.maxMs,
      Math.round(this.opts.baseMs * this.opts.factor ** this.attempts),
    );
    this.attempts += 1;
    return exp;
  }

  reset(): void {
    this.attempts = 0;
  }

  get currentAttempts(): number {
    return this.attempts;
  }
}
