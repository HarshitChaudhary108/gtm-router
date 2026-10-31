import { LIMITS } from "../config.js";
import { AppError } from "../errors.js";
import { assertUpstreamOk, fetchWithRetry, readJsonBody, type FetchLike } from "../http.js";
import type { ApolloCompanyParams, ApolloPeopleParams } from "../registry.js";
import type { CompaniesData, CompanyResult, PeopleData, PeopleResult } from "../types.js";
import { isRecord } from "../util.js";
import { domainOrNull, httpUrlOrNull, num, scalar, str } from "./common.js";

const APOLLO_BASE = "https://api.apollo.io/api/v1";

export interface ApolloDeps {
  apiKey?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  retryDelayMs?: number;
  maxResults?: number;
}

function totalOf(payload: Record<string, unknown>, fallback: number): number {
  const pagination = isRecord(payload.pagination) ? payload.pagination : null;
  return (pagination && num(pagination.total_entries)) ?? fallback;
}

/** Map Apollo organization search results into the router's company shape. Never invents fields. */
export function normalizeApolloCompanies(payload: unknown, maxResults: number = LIMITS.maxMoltResults): CompaniesData {
  if (!isRecord(payload) || !Array.isArray(payload.organizations)) {
    throw new AppError("E_PROVIDER", "Apollo response did not contain an organizations array");
  }

  const results: CompanyResult[] = [];
  for (const item of payload.organizations.slice(0, maxResults)) {
    if (!isRecord(item)) continue;
    results.push({
      name: str(item.name),
      domain: domainOrNull(item.primary_domain ?? item.website_url),
      industry: str(item.industry),
      employee_count: scalar(item.estimated_num_employees),
      employee_range: str(item.employee_range),
      revenue_range: null,
      linkedin_url: httpUrlOrNull(item.linkedin_url),
      city: str(item.city),
      state: str(item.state),
      country: str(item.country),
      naics_codes: [],
      naics_titles: [],
      linkedin_industry: [],
      score: null,
    });
  }

  return { results, total: totalOf(payload, results.length) };
}

/** Map Apollo people search results into the router's people shape. Search never returns emails. */
export function normalizeApolloPeople(payload: unknown, maxResults: number = LIMITS.maxMoltResults): PeopleData {
  if (!isRecord(payload) || !Array.isArray(payload.people)) {
    throw new AppError("E_PROVIDER", "Apollo response did not contain a people array");
  }

  const results: PeopleResult[] = [];
  for (const item of payload.people.slice(0, maxResults)) {
    if (!isRecord(item)) continue;
    const org = isRecord(item.organization) ? item.organization : null;
    results.push({
      name: str(item.name) ?? ([str(item.first_name), str(item.last_name)].filter(Boolean).join(" ") || null),
      title: str(item.title),
      seniority: str(item.seniority),
      headline: str(item.headline),
      city: str(item.city),
      state: str(item.state),
      country: str(item.country),
      functional_area: [],
      linkedin_url: httpUrlOrNull(item.linkedin_url),
      // Apollo search only reports whether a verified email exists; it does not return the address.
      business_email: null,
      business_email_risk_score: null,
      business_email_validated_at: null,
      business_email_status: item.has_email === true ? "available_via_enrichment" : null,
      business_email_score: null,
      company_name: org ? str(org.name) : null,
      company_domain: org ? domainOrNull(org.primary_domain) : null,
      company_industry: org ? str(org.industry) : null,
      score: null,
    });
  }

  return { results, total: totalOf(payload, results.length) };
}

async function post(path: string, body: unknown, deps: ApolloDeps): Promise<unknown> {
  if (!deps.apiKey) throw new AppError("E_CONFIG", "APOLLO_API_KEY is not configured; Apollo actions are unavailable");

  const res = await fetchWithRetry(
    `${APOLLO_BASE}${path}`,
    {
      method: "POST",
      headers: {
        "x-api-key": deps.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    },
    {
      fetchImpl: deps.fetchImpl,
      timeoutMs: deps.timeoutMs ?? LIMITS.searchTimeoutMs,
      maxRetries: 1,
      retryDelayMs: deps.retryDelayMs,
    },
  );

  if (res.status === 402) throw new AppError("E_QUOTA", "Apollo credits exhausted (HTTP 402)");
  if (res.status === 403) {
    throw new AppError(
      "E_PROVIDER_AUTH",
      "Apollo rejected the request (HTTP 403); the key may lack master-key access or the plan may not include this API",
    );
  }
  assertUpstreamOk(res, "Apollo");
  return readJsonBody(res, "Apollo");
}

export async function searchApolloCompanies(params: ApolloCompanyParams, deps: ApolloDeps): Promise<CompaniesData> {
  const payload = await post(
    "/mixed_companies/search",
    {
      q_organization_name: params.query,
      q_organization_domains: Array.isArray(params.domain) ? params.domain.join(",") : params.domain,
      organization_locations: params.location ? [params.location] : undefined,
      organization_num_employees_ranges: params.employee_range
        ? Array.isArray(params.employee_range)
          ? params.employee_range
          : [params.employee_range]
        : undefined,
      q_organization_keyword_tags: params.industry ? [params.industry] : undefined,
      page: params.page,
      per_page: params.limit,
    },
    deps,
  );
  return normalizeApolloCompanies(payload, deps.maxResults ?? LIMITS.maxMoltResults);
}

export async function searchApolloPeople(params: ApolloPeopleParams, deps: ApolloDeps): Promise<PeopleData> {
  const payload = await post(
    "/mixed_people/search",
    {
      q_keywords: params.query,
      person_titles: params.title ? (Array.isArray(params.title) ? params.title : [params.title]) : undefined,
      person_seniorities: params.seniority
        ? Array.isArray(params.seniority)
          ? params.seniority
          : [params.seniority]
        : undefined,
      person_locations: params.location ? [params.location] : undefined,
      q_organization_domains: Array.isArray(params.company_domain)
        ? params.company_domain.join(",")
        : params.company_domain,
      page: params.page,
      per_page: params.limit,
    },
    deps,
  );
  return normalizeApolloPeople(payload, deps.maxResults ?? LIMITS.maxMoltResults);
}
