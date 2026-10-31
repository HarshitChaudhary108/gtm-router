import { LIMITS } from "../config.js";
import { AppError } from "../errors.js";
import { assertUpstreamOk, fetchWithRetry, readJsonBody, type FetchLike } from "../http.js";
import type { SearchParams } from "../registry.js";
import type { SearchData, SearchResult } from "../types.js";
import { isRecord } from "../util.js";
import { strList, toSearchResult } from "./common.js";

const PARALLEL_SEARCH_URL = "https://api.parallel.ai/v1/search";

export interface ParallelDeps {
  apiKey?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  retryDelayMs?: number;
  maxResultChars?: number;
}

function excerptText(item: Record<string, unknown>): string | null {
  if (Array.isArray(item.excerpts)) {
    const parts = item.excerpts
      .map((excerpt) => (isRecord(excerpt) ? (typeof excerpt.text === "string" ? excerpt.text.trim() : "") : ""))
      .filter(Boolean);
    if (parts.length > 0) return parts.join("\n\n");
  }
  return typeof item.snippet === "string" && item.snippet.trim() ? item.snippet.trim() : null;
}

/** Map Parallel's Search API response into the router's search shape. Never invents fields. */
export function normalizeParallel(payload: unknown, fallbackQuery: string, maxResultChars: number = LIMITS.maxResultChars): SearchData {
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    throw new AppError("E_PROVIDER", "Parallel response did not contain a results array");
  }

  const results: SearchResult[] = [];
  for (const item of payload.results.slice(0, LIMITS.maxResultsCap)) {
    if (!isRecord(item)) continue;
    const result = toSearchResult(
      { title: item.title, url: item.url, content: excerptText(item) },
      maxResultChars,
    );
    if (result) results.push(result);
  }

  const query = strList(payload.search_queries)[0] ?? fallbackQuery;
  return { query, results };
}

export async function searchParallel(params: SearchParams, deps: ParallelDeps): Promise<SearchData> {
  if (!deps.apiKey) {
    throw new AppError("E_CONFIG", "PARALLEL_API_KEY is not configured; parallel search is unavailable");
  }

  const res = await fetchWithRetry(
    PARALLEL_SEARCH_URL,
    {
      method: "POST",
      headers: {
        "x-api-key": deps.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        search_queries: [params.query],
        mode: "fast",
        advanced_settings: { max_results: Math.min(params.max_results, LIMITS.maxResultsCap) },
      }),
    },
    {
      fetchImpl: deps.fetchImpl,
      timeoutMs: deps.timeoutMs ?? LIMITS.searchTimeoutMs,
      maxRetries: 1,
      retryDelayMs: deps.retryDelayMs,
    },
  );

  if (res.status === 402) throw new AppError("E_QUOTA", "Parallel quota exhausted (HTTP 402)");
  assertUpstreamOk(res, "Parallel");
  return normalizeParallel(await readJsonBody(res, "Parallel"), params.query, deps.maxResultChars);
}
