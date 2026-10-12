/** An HTTP response that wasn't usable. `status` is the HTTP status (502 for a malformed body). */
export class SocrataError extends Error {
  override name = "SocrataError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** 429, 5xx, timeouts and network failures are worth retrying; other 4xx mean the request itself is wrong. */
export function isRetryable(err: unknown): boolean {
  if (err instanceof SocrataError) return err.status === 429 || err.status >= 500;
  return true;
}

export type RetryOptions = {
  /** Extra attempts after the first. Default 3. */
  retries?: number;
  /** First backoff delay in ms. Default 500. */
  baseMs?: number;
  /** Backoff ceiling in ms. Default 8000. */
  maxMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
};

/** Runs `fn`, retrying retryable failures with exponential backoff and jitter. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { retries = 3, baseMs = 500, maxMs = 8000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = opts;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      const delay = Math.min(maxMs, baseMs * 2 ** attempt) * (0.75 + Math.random() * 0.5);
      opts.onRetry?.(attempt + 1, Math.round(delay), err);
      await sleep(delay);
    }
  }
}
