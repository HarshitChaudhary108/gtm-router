import { LIMITS } from "../config.js";
import { AppError } from "../errors.js";
import { assertUpstreamOk, fetchWithRetry, readJsonBody, type FetchLike } from "../http.js";
import type { SearchParams } from "../registry.js";
import type { SearchData, SearchResult } from "../types.js";
import { isRecord } from "../util.js";
import { toSearchResult } from "./common.js";

const YOU_SEARCH_URL = "https://ydc-index.io/v1/search";

export interface YouDeps {
  apiKey?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  retryDelayMs?: number;
  maxResultChars?: number;
}

function youContent(item: Record<string, unknown>): string | null {
  if (Array.isArray(item.snippets)) {
    const parts = item.snippets
      .filter((snippet): snippet is string => typeof snippet === "string" && snippet.trim() !== "")
      .map((snippet) => snippet.trim());
    if (parts.length > 0) return parts.join("\n\n");
  }
  return typeof item.description === "string" && item.description.trim() ? item.description.trim() : null;
}

/** Map You.com's search response into the router's search shape. Never invents fields. */
export function normalizeYou(payload: unknown, fallbackQuery: string, maxResultChars: number = LIMITS.maxResultChars): SearchData {
  const resultsContainer = isRecord(payload) && isRecord(payload.results) ? payload.results : null;
  const web = resultsContainer && Array.isArray(resultsContainer.web) ? resultsContainer.web : null;
  if (!web) throw new AppError("E_PROVIDER", "You.com response did not contain results.web");

  const results: SearchResult[] = [];
  for (const item of web.slice(0, LIMITS.maxResultsCap)) {
    if (!isRecord(item)) continue;
    const result = toSearchResult({ title: item.title, url: item.url, content: youContent(item) }, maxResultChars);
    if (result) results.push(result);
  }

  return { query: fallbackQuery, results };
}

export async function searchYou(params: SearchParams, deps: YouDeps): Promise<SearchData> {
  if (!deps.apiKey) {
    throw new AppError("E_CONFIG", "YOU_API_KEY is not configured; You.com search is unavailable");
  }

  const res = await fetchWithRetry(
    YOU_SEARCH_URL,
    {
      method: "POST",
      headers: {
        "X-API-Key": deps.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query: params.query, count: Math.min(params.max_results, LIMITS.maxResultsCap) }),
    },
    {
      fetchImpl: deps.fetchImpl,
      timeoutMs: deps.timeoutMs ?? LIMITS.searchTimeoutMs,
      maxRetries: 1,
      retryDelayMs: deps.retryDelayMs,
    },
  );

  if (res.status === 402) throw new AppError("E_QUOTA", "You.com quota exhausted (HTTP 402)");
  assertUpstreamOk(res, "You.com");
  return normalizeYou(await readJsonBody(res, "You.com"), params.query, deps.maxResultChars);
}
