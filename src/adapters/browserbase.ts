import { LIMITS } from "../config.js";
import { AppError } from "../errors.js";
import { assertUpstreamOk, fetchWithRetry, readJsonBody, type FetchLike } from "../http.js";
import type { ReadParams } from "../registry.js";
import type { PageData } from "../types.js";
import { assertResolvablePublicUrl, type LookupFn } from "../url-safety.js";
import { isRecord, truncate } from "../util.js";
import { httpUrlOrNull, str } from "./common.js";

const BROWSERBASE_FETCH_URL = "https://api.browserbase.com/v1/fetch";

export interface BrowserbaseDeps {
  apiKey?: string;
  fetchImpl?: FetchLike;
  lookup?: LookupFn;
  timeoutMs?: number;
  retryDelayMs?: number;
  maxChars?: number;
}

/** Map Browserbase's fetch response into the router's page shape. Never invents fields. */
export function normalizeBrowserbase(payload: unknown, requestedUrl: string, maxChars: number = LIMITS.maxPageChars): PageData {
  if (!isRecord(payload)) throw new AppError("E_PROVIDER", "Browserbase returned an unexpected payload");

  const metadata = isRecord(payload.metadata) ? payload.metadata : {};
  const content =
    (typeof payload.content === "string" && payload.content.trim() ? payload.content : null) ??
    (typeof payload.markdown === "string" && payload.markdown.trim() ? payload.markdown : null) ??
    (typeof payload.text === "string" && payload.text.trim() ? payload.text : null);

  if (!content) throw new AppError("E_PROVIDER", "Browserbase fetch returned no readable content");

  const clipped = truncate(content, maxChars);
  return {
    url: requestedUrl,
    final_url: httpUrlOrNull(metadata.url ?? payload.finalUrl ?? payload.url) ?? requestedUrl,
    title: str(metadata.title ?? payload.title),
    description: str(metadata.description ?? payload.description),
    content: clipped.text,
    content_length: content.length,
    truncated: clipped.truncated,
  };
}

export async function readBrowserbase(params: ReadParams, deps: BrowserbaseDeps): Promise<PageData> {
  if (!deps.apiKey) {
    throw new AppError("E_CONFIG", "BROWSERBASE_API_KEY is not configured; Browserbase fetch is unavailable");
  }

  const target = await assertResolvablePublicUrl(params.url, deps.lookup);

  const res = await fetchWithRetry(
    BROWSERBASE_FETCH_URL,
    {
      method: "POST",
      headers: {
        "X-BB-API-Key": deps.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ url: target.href, format: "markdown" }),
    },
    {
      fetchImpl: deps.fetchImpl,
      timeoutMs: deps.timeoutMs ?? LIMITS.readTimeoutMs,
      maxRetries: 1,
      retryDelayMs: deps.retryDelayMs,
    },
  );

  if (res.status === 402) throw new AppError("E_QUOTA", "Browserbase credits exhausted (HTTP 402)");
  assertUpstreamOk(res, "Browserbase");
  return normalizeBrowserbase(await readJsonBody(res, "Browserbase"), target.href, deps.maxChars);
}
