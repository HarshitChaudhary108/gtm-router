import { LIMITS } from "../config.js";
import type { SearchResult } from "../types.js";
import { assertPublicHttpUrl } from "../url-safety.js";
import { truncate } from "../util.js";

export const SNIPPET_CHARS = 300;

export function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim() !== "")
    .map((item) => item.trim());
}

export function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Upstream sometimes returns counts as numbers; keep them as strings without inventing values. */
export function scalar(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return str(value);
}

export function domainOrNull(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return url.protocol === "http:" || url.protocol === "https:" ? url.hostname : null;
  } catch {
    return null;
  }
}

export function httpUrlOrNull(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Drop non-public or malformed URLs instead of surfacing them. */
export function publicUrlOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return assertPublicHttpUrl(value).href;
  } catch {
    return null;
  }
}

export interface RawSearchHit {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  score?: unknown;
}

/** Map one provider hit into the router's search shape. Returns null for unusable URLs. */
export function toSearchResult(
  hit: RawSearchHit,
  maxResultChars: number = LIMITS.maxResultChars,
): SearchResult | null {
  const url = publicUrlOrNull(hit.url);
  if (!url) return null;

  const content = typeof hit.content === "string" && hit.content.trim() ? hit.content.trim() : null;
  const snippet = content ? truncate(content, SNIPPET_CHARS) : null;
  const clipped = content ? truncate(content, maxResultChars) : null;

  return {
    title: str(hit.title),
    url,
    snippet: snippet ? (snippet.truncated ? `${snippet.text}…` : snippet.text) : null,
    content: clipped?.text ?? null,
    content_truncated: clipped?.truncated ?? false,
    score: num(hit.score),
  };
}
