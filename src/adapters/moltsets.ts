import { LIMITS } from "../config.js";
import { AppError } from "../errors.js";
import { assertUpstreamOk, fetchWithRetry, readJsonBody, type FetchLike } from "../http.js";
import type { CompanySearchParams, PeopleSearchParams } from "../registry.js";
import type { CompaniesData, CompanyResult, PeopleData, PeopleResult } from "../types.js";
import { isRecord } from "../util.js";
import { domainOrNull, httpUrlOrNull, num, scalar, str, strList } from "./common.js";

const MOLTSETS_TOOLS_URL = "https://api.moltsets.com/api/v1/tools";
const USER_AGENT = "outmate/0.1.0";

export interface MoltsetsDeps {
  apiKey?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  retryDelayMs?: number;
  maxResults?: number;
}

function resultsEnvelope(payload: unknown): { list: unknown[]; total: number } {
  if (!isRecord(payload) || !isRecord(payload.results) || !Array.isArray(payload.results.results)) {
    throw new AppError("E_PROVIDER", "MoltSets response did not contain a results array");
  }
  const list = payload.results.results;
  const total = num(payload.results.total);
  return { list, total: total === null ? list.length : total };
}

/** Map MoltSets search_companies results into the router's company shape. Never invents fields. */
export function normalizeCompanies(payload: unknown, maxResults: number = LIMITS.maxMoltResults): CompaniesData {
  const { list, total } = resultsEnvelope(payload);
  const results: CompanyResult[] = [];

  for (const item of list.slice(0, maxResults)) {
    if (!isRecord(item)) continue;
    results.push({
      name: str(item.name),
      domain: domainOrNull(item.domain),
      industry: str(item.industry),
      employee_count: scalar(item.employee_count),
      employee_range: str(item.employee_range),
      revenue_range: str(item.revenue_range),
      linkedin_url: httpUrlOrNull(item.linkedin_url),
      city: str(item.city),
      state: str(item.state),
      country: str(item.country),
      naics_codes: strList(item.naics_codes),
      naics_titles: strList(item.naics_titles),
      linkedin_industry: strList(item.linkedin_industry),
      score: num(item._score),
    });
  }

  return { results, total };
}

/** Map MoltSets search_people results into the router's people shape. Never invents fields. */
export function normalizePeople(payload: unknown, maxResults: number = LIMITS.maxMoltResults): PeopleData {
  const { list, total } = resultsEnvelope(payload);
  const results: PeopleResult[] = [];

  for (const item of list.slice(0, maxResults)) {
    if (!isRecord(item)) continue;
    const company = isRecord(item.company) ? item.company : null;
    results.push({
      name: str(item.full_name),
      title: str(item.title),
      seniority: str(item.seniority),
      headline: str(item.headline),
      city: str(item.city),
      state: str(item.state),
      country: str(item.country),
      functional_area: strList(item.functional_area),
      linkedin_url: httpUrlOrNull(item.linkedin_url),
      business_email: str(item.business_email),
      business_email_risk_score: scalar(item.business_email_risk_score),
      business_email_validated_at: scalar(item.business_email_validated_at),
      business_email_status: null,
      business_email_score: null,
      company_name: company ? str(company.name) : null,
      company_domain: company ? domainOrNull(company.domain) : null,
      company_industry: company ? str(company.industry) : null,
      score: num(item._score),
    });
  }

  return { results, total };
}

async function callTool(tool: "search_companies" | "search_people", body: unknown, deps: MoltsetsDeps): Promise<unknown> {
  if (!deps.apiKey) {
    throw new AppError("E_CONFIG", "MOLTSETS_API_KEY is not configured; MoltSets actions are unavailable");
  }

  const res = await fetchWithRetry(
    `${MOLTSETS_TOOLS_URL}/${tool}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deps.apiKey}`,
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    },
    {
      fetchImpl: deps.fetchImpl,
      timeoutMs: deps.timeoutMs ?? LIMITS.moltsetsTimeoutMs,
      // MoltSets asks clients not to retry automatically; surface 429/5xx instead.
      maxRetries: 0,
      retryDelayMs: deps.retryDelayMs,
    },
  );

  if (res.status === 402) {
    throw new AppError("E_QUOTA", "MoltSets quota exhausted (HTTP 402)");
  }
  if (res.status === 401 || res.status === 403) {
    throw new AppError("E_PROVIDER_AUTH", `MoltSets rejected the request (HTTP ${res.status}); check the API key and plan`);
  }
  assertUpstreamOk(res, "MoltSets");
  return readJsonBody(res, "MoltSets");
}

export async function searchCompanies(params: CompanySearchParams, deps: MoltsetsDeps): Promise<CompaniesData> {
  const payload = await callTool("search_companies", params, deps);
  return normalizeCompanies(payload, deps.maxResults);
}

export async function searchPeople(params: PeopleSearchParams, deps: MoltsetsDeps): Promise<PeopleData> {
  const payload = await callTool("search_people", params, deps);
  return normalizePeople(payload, deps.maxResults);
}
