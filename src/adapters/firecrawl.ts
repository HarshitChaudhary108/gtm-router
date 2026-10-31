import { LIMITS } from "../config.js";
import { AppError } from "../errors.js";
import { assertUpstreamOk, fetchWithRetry, readJsonBody, type FetchLike } from "../http.js";
import type { ReadParams, SearchParams } from "../registry.js";
import type { PageData, SearchData, SearchResult } from "../types.js";
import { assertResolvablePublicUrl, type LookupFn } from "../url-safety.js";
import { isRecord, truncate } from "../util.js";
import { httpUrlOrNull, toSearchResult } from "./common.js";

const FIRECRAWL_BASE = "https://api.firecrawl.dev/v2";

export interface FirecrawlDeps {
  apiKey?: string;
  fetchImpl?: FetchLike;
  lookup?: LookupFn;
  timeoutMs?: number;
  retryDelayMs?: number;
  maxResultChars?: number;
  maxChars?: number;
}

/** Map Firecrawl's v2 search response into the router's search shape. Never invents fields. */
export function normalizeFirecrawlSearch(
  payload: unknown,
  fallbackQuery: string,
  maxResultChars: number = LIMITS.maxResultChars,
): SearchData {
  if (!isRecord(payload) || !isRecord(payload.data) || !Array.isArray(payload.data.web)) {
    throw new AppError("E_PROVIDER", "Firecrawl search response did not contain data.web");
  }

  const results: SearchResult[] = [];
  for (const item of payload.data.web.slice(0, LIMITS.maxResultsCap)) {
    if (!isRecord(item)) continue;
    const result = toSearchResult(
      { title: item.title, url: item.url, content: item.markdown ?? item.description },
      maxResultChars,
    );
    if (result) results.push(result);
  }

  return { query: fallbackQuery, results };
}

/** Map Firecrawl's scrape response into the router's page shape. Never invents fields. */
export function normalizeFirecrawlPage(payload: unknown, requestedUrl: string, maxChars: number = LIMITS.maxPageChars): PageData {
  if (!isRecord(payload) || !isRecord(payload.data)) {
    throw new AppError("E_PROVIDER", "Firecrawl scrape response did not contain data");
  }
  const data = payload.data;
  const metadata = isRecord(data.metadata) ? data.metadata : {};
  const content = typeof data.markdown === "string" && data.markdown.trim() ? data.markdown : null;
  if (!content) throw new AppError("E_PROVIDER", "Firecrawl scrape returned no markdown content");

  const clipped = truncate(content, maxChars);
  return {
    url: requestedUrl,
    final_url: httpUrlOrNull(metadata.url ?? metadata.sourceURL) ?? requestedUrl,
    title: typeof metadata.title === "string" && metadata.title.trim() ? metadata.title : null,
    description:
      typeof metadata.description === "string" && metadata.description.trim() ? metadata.description : null,
    content: clipped.text,
    content_length: content.length,
    truncated: clipped.truncated,
  };
}

function requireKey(deps: FirecrawlDeps, action: string): string {
  if (!deps.apiKey) throw new AppError("E_CONFIG", `FIRECRAWL_API_KEY is not configured; ${action} is unavailable`);
  return deps.apiKey;
}

export async function searchFirecrawl(params: SearchParams, deps: FirecrawlDeps): Promise<SearchData> {
  const apiKey = requireKey(deps, "Firecrawl search");

  const res = await fetchWithRetry(
    `${FIRECRAWL_BASE}/search`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        query: params.query,
        limit: Math.min(params.max_results, LIMITS.maxResultsCap),
        scrapeOptions: { formats: ["markdown"] },
      }),
    },
    {
      fetchImpl: deps.fetchImpl,
      timeoutMs: deps.timeoutMs ?? LIMITS.searchTimeoutMs,
      maxRetries: 1,
      retryDelayMs: deps.retryDelayMs,
    },
  );

  if (res.status === 402) throw new AppError("E_QUOTA", "Firecrawl credits exhausted (HTTP 402)");
  assertUpstreamOk(res, "Firecrawl");
  return normalizeFirecrawlSearch(await readJsonBody(res, "Firecrawl"), params.query, deps.maxResultChars);
}

export async function readFirecrawl(params: ReadParams, deps: FirecrawlDeps): Promise<PageData> {
  const apiKey = requireKey(deps, "Firecrawl scrape");
  const target = await assertResolvablePublicUrl(params.url, deps.lookup);

  const res = await fetchWithRetry(
    `${FIRECRAWL_BASE}/scrape`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ url: target.href, formats: ["markdown"], onlyMainContent: true }),
    },
    {
      fetchImpl: deps.fetchImpl,
      timeoutMs: deps.timeoutMs ?? LIMITS.readTimeoutMs,
      maxRetries: 1,
      retryDelayMs: deps.retryDelayMs,
    },
  );

  if (res.status === 402) throw new AppError("E_QUOTA", "Firecrawl credits exhausted (HTTP 402)");
  assertUpstreamOk(res, "Firecrawl");
  return normalizeFirecrawlPage(await readJsonBody(res, "Firecrawl"), target.href, deps.maxChars);
}
