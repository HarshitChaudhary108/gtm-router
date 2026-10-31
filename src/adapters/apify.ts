import { LIMITS } from "../config.js";
import { AppError } from "../errors.js";
import { assertUpstreamOk, fetchWithRetry, readJsonBody, type FetchLike } from "../http.js";
import type { SearchParams } from "../registry.js";
import type { SearchData, SearchResult } from "../types.js";
import { isRecord } from "../util.js";
import { toSearchResult } from "./common.js";

// Allowlisted actor only. Accepting a user-supplied actor ID would allow arbitrary code execution.
const APIFY_ACTOR_URL =
  "https://api.apify.com/v2/acts/apify~google-search-scraper/run-sync-get-dataset-items";

export interface ApifyDeps {
  apiKey?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  retryDelayMs?: number;
  maxResultChars?: number;
}

/** Map the Google Search Scraper dataset items into the router's search shape. Never invents fields. */
export function normalizeApify(payload: unknown, fallbackQuery: string, maxResultChars: number = LIMITS.maxResultChars): SearchData {
  if (!Array.isArray(payload)) {
    throw new AppError("E_PROVIDER", "Apify returned an unexpected dataset payload");
  }

  const results: SearchResult[] = [];
  for (const item of payload) {
    if (!isRecord(item) || !Array.isArray(item.organicResults)) continue;
    for (const hit of item.organicResults) {
      if (results.length >= LIMITS.maxResultsCap) break;
      if (!isRecord(hit)) continue;
      const result = toSearchResult({ title: hit.title, url: hit.url, content: hit.description }, maxResultChars);
      if (result) results.push(result);
    }
    if (results.length >= LIMITS.maxResultsCap) break;
  }

  return { query: fallbackQuery, results };
}

export async function searchApify(params: SearchParams, deps: ApifyDeps): Promise<SearchData> {
  if (!deps.apiKey) {
    throw new AppError("E_CONFIG", "APIFY_API_KEY is not configured; Apify search is unavailable");
  }

  const res = await fetchWithRetry(
    APIFY_ACTOR_URL,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deps.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        queries: params.query,
        maxPagesPerQuery: 1,
        resultsPerPage: Math.min(params.max_results, LIMITS.maxResultsCap),
      }),
    },
    {
      fetchImpl: deps.fetchImpl,
      timeoutMs: deps.timeoutMs ?? LIMITS.apifyTimeoutMs,
      // Sync actor runs can take minutes; a blind retry would duplicate a billable run.
      maxRetries: 0,
      retryDelayMs: deps.retryDelayMs,
    },
  );

  if (res.status === 402) throw new AppError("E_QUOTA", "Apify credits exhausted (HTTP 402)");
  assertUpstreamOk(res, "Apify");
  return normalizeApify(await readJsonBody(res, "Apify"), params.query, deps.maxResultChars);
}
