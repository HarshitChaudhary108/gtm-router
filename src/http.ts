import { AppError } from "./errors.js";
import { sleep } from "./util.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface FetchOptions {
  fetchImpl?: FetchLike;
  timeoutMs: number;
  /** Retries after the first attempt. Only transient failures (429, 5xx, network) are retried. */
  maxRetries?: number;
  retryDelayMs?: number;
}

function retryAfterMs(res: Response, fallback: number): number {
  const header = res.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1000, 0), 2000);
  }
  return fallback;
}

function isAbortError(err: unknown): boolean {
  const name = err instanceof Error || err instanceof DOMException ? err.name : "";
  return name === "AbortError" || name === "TimeoutError";
}

/** Fetch with a per-attempt timeout and bounded retries for transient failures. */
export async function fetchWithRetry(url: string, init: RequestInit, opts: FetchOptions): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const attempts = Math.max(0, opts.maxRetries ?? 1) + 1;
  const backoff = opts.retryDelayMs ?? 300;
  let lastError: AppError | undefined;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const signal = AbortSignal.timeout(opts.timeoutMs);
    try {
      const res = await fetchImpl(url, { ...init, signal });
      const transient = res.status === 429 || res.status >= 500;
      if (transient && attempt < attempts - 1) {
        await sleep(retryAfterMs(res, backoff));
        continue;
      }
      return res;
    } catch (err) {
      lastError =
        signal.aborted || isAbortError(err)
          ? new AppError("E_TIMEOUT", "Upstream request timed out", { retryable: true, cause: err })
          : new AppError("E_PROVIDER", "Upstream request failed (network error)", { retryable: true, cause: err });
      if (attempt < attempts - 1) await sleep(backoff);
    }
  }

  throw lastError ?? new AppError("E_PROVIDER", "Upstream request failed", { retryable: true });
}

export function assertUpstreamOk(res: Response, provider: string): void {
  if (res.ok) return;
  if (res.status === 401 || res.status === 403) {
    throw new AppError("E_PROVIDER_AUTH", `${provider} rejected the API credentials (HTTP ${res.status})`);
  }
  if (res.status === 429) {
    throw new AppError("E_RATE_LIMIT", `${provider} rate limit reached (HTTP 429)`, { retryable: true });
  }
  if (res.status >= 500) {
    throw new AppError("E_PROVIDER", `${provider} is unavailable (HTTP ${res.status})`, { retryable: true });
  }
  throw new AppError("E_PROVIDER", `${provider} request failed (HTTP ${res.status})`);
}

/** Read a response body with a hard byte cap so a huge page cannot exhaust memory. */
export async function readTextCapped(res: Response, maxBytes = 4_000_000): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: await res.text(), truncated: false };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        chunks.push(decoder.decode(value.subarray(0, Math.max(0, remaining)), { stream: true }));
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      total += value.byteLength;
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Reader already released or cancelled.
    }
  }
  chunks.push(decoder.decode());
  return { text: chunks.join(""), truncated };
}

export async function readJsonBody(res: Response, provider: string): Promise<unknown> {
  const { text, truncated } = await readTextCapped(res);
  if (truncated) throw new AppError("E_PROVIDER", `${provider} response exceeded the 4 MB size limit`);
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError("E_PROVIDER", `${provider} returned a non-JSON response`);
  }
}
