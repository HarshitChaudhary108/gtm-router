import { LIMITS } from "../config.js";
import { AppError } from "../errors.js";
import { assertUpstreamOk, fetchWithRetry, readJsonBody, type FetchLike } from "../http.js";
import type { HunterDomainParams, HunterEmailParams } from "../registry.js";
import type { PeopleData, PeopleResult } from "../types.js";
import { isRecord } from "../util.js";
import { domainOrNull, httpUrlOrNull, num, str } from "./common.js";

const HUNTER_BASE = "https://api.hunter.io/v2";

export interface HunterDeps {
  apiKey?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  retryDelayMs?: number;
  maxResults?: number;
}

function person(input: {
  first_name?: unknown;
  last_name?: unknown;
  name?: unknown;
  position?: unknown;
  seniority?: unknown;
  linkedin?: unknown;
  email?: unknown;
  status?: unknown;
  score?: unknown;
  company?: unknown;
  domain?: unknown;
}): PeopleResult {
  const name =
    str(input.name) ??
    ([str(input.first_name), str(input.last_name)].filter(Boolean).join(" ") || null);

  return {
    name,
    title: str(input.position),
    seniority: str(input.seniority),
    headline: null,
    city: null,
    state: null,
    country: null,
    functional_area: [],
    linkedin_url: httpUrlOrNull(input.linkedin),
    business_email: str(input.email),
    business_email_risk_score: null,
    business_email_validated_at: null,
    business_email_status: str(input.status),
    business_email_score: num(input.score),
    company_name: str(input.company),
    company_domain: domainOrNull(input.domain),
    company_industry: null,
    score: null,
  };
}

/** Map Hunter's domain-search response into the router's people shape. Never invents fields. */
export function normalizeHunterDomain(payload: unknown, maxResults: number = LIMITS.maxMoltResults): PeopleData {
  const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
  if (!data || !Array.isArray(data.emails)) {
    throw new AppError("E_PROVIDER", "Hunter response did not contain data.emails");
  }

  const domain = str(data.domain);
  const organization = str(data.organization);
  const results: PeopleResult[] = [];

  for (const item of data.emails.slice(0, maxResults)) {
    if (!isRecord(item)) continue;
    const verification = isRecord(item.verification) ? item.verification : null;
    results.push(
      person({
        first_name: item.first_name,
        last_name: item.last_name,
        position: item.position,
        seniority: item.seniority,
        linkedin: item.linkedin,
        email: item.value,
        status: verification?.status,
        score: item.confidence,
        company: organization,
        domain,
      }),
    );
  }

  const meta = isRecord(payload) && isRecord(payload.meta) ? payload.meta : null;
  return { results, total: (meta && num(meta.results)) ?? results.length };
}

/** Map Hunter's email-finder response into a single-person list. Never invents fields. */
export function normalizeHunterFinder(payload: unknown): PeopleData {
  if (!isRecord(payload) || !isRecord(payload.data)) {
    throw new AppError("E_PROVIDER", "Hunter finder response did not contain data");
  }
  const data = payload.data;
  if (typeof data.email !== "string" || !data.email.trim()) {
    return { results: [], total: 0 };
  }
  const verification = isRecord(data.verification) ? data.verification : null;

  return {
    results: [
      person({
        first_name: data.first_name,
        last_name: data.last_name,
        position: data.position,
        linkedin: data.linkedin_url,
        email: data.email,
        status: verification?.status,
        score: data.score,
        company: data.company,
        domain: data.domain,
      }),
    ],
    total: 1,
  };
}

/** Map Hunter's email-verifier response into a single-person list. Never invents fields. */
export function normalizeHunterVerifier(payload: unknown): PeopleData {
  if (!isRecord(payload) || !isRecord(payload.data)) {
    throw new AppError("E_PROVIDER", "Hunter verifier response did not contain data");
  }
  const data = payload.data;
  if (typeof data.email !== "string" || !data.email.trim()) {
    throw new AppError("E_PROVIDER", "Hunter verifier response did not contain an email");
  }

  return {
    results: [
      person({
        email: data.email,
        status: data.status ?? data.result,
        score: data.score,
      }),
    ],
    total: 1,
  };
}

async function get(path: string, query: Record<string, string | number | undefined>, deps: HunterDeps): Promise<unknown> {
  if (!deps.apiKey) throw new AppError("E_CONFIG", "HUNTER_API_KEY is not configured; Hunter actions are unavailable");

  const url = new URL(`${HUNTER_BASE}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }

  const res = await fetchWithRetry(
    url.href,
    { method: "GET", headers: { "X-API-KEY": deps.apiKey, Accept: "application/json" } },
    {
      fetchImpl: deps.fetchImpl,
      timeoutMs: deps.timeoutMs ?? LIMITS.searchTimeoutMs,
      maxRetries: 1,
      retryDelayMs: deps.retryDelayMs,
    },
  );

  if (res.status === 402) throw new AppError("E_QUOTA", "Hunter credits exhausted (HTTP 402)");
  assertUpstreamOk(res, "Hunter");
  return readJsonBody(res, "Hunter");
}

export async function searchHunterDomain(params: HunterDomainParams, deps: HunterDeps): Promise<PeopleData> {
  const payload = await get(
    "/domain-search",
    { domain: params.domain, limit: params.limit, seniority: params.seniority, department: params.department },
    deps,
  );
  return normalizeHunterDomain(payload, deps.maxResults ?? LIMITS.maxMoltResults);
}

export async function findHunterEmail(params: HunterEmailParams, deps: HunterDeps): Promise<PeopleData> {
  if (params.email) {
    const payload = await get("/email-verifier", { email: params.email }, deps);
    return normalizeHunterVerifier(payload);
  }

  const payload = await get(
    "/email-finder",
    {
      domain: params.domain,
      first_name: params.first_name,
      last_name: params.last_name,
      linkedin_url: params.linkedin_url,
    },
    deps,
  );
  return normalizeHunterFinder(payload);
}
