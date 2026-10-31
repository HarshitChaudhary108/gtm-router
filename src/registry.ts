import { AppError } from "./errors.js";
import { assertPublicHttpUrl } from "./url-safety.js";
import { isRecord } from "./util.js";

export const SEARCH_PROVIDERS = ["tavily", "parallel", "you", "linkup", "firecrawl", "serper", "apify"] as const;
export const READ_PROVIDERS = ["jina", "firecrawl", "browserbase"] as const;

export type SearchProvider = (typeof SEARCH_PROVIDERS)[number];
export type ReadProvider = (typeof READ_PROVIDERS)[number];

export interface SearchParams {
  query: string;
  max_results: number;
  search_depth: "basic" | "advanced";
  /** Defaults to tavily. `parse` always populates this. */
  provider?: SearchProvider;
}

export interface ReadParams {
  url: string;
  /** Defaults to jina. `parse` always populates this. */
  provider?: ReadProvider;
}

export interface ApolloCompanyParams {
  query?: string;
  domain?: FilterValue;
  location?: string;
  employee_range?: FilterValue;
  industry?: string;
  limit: number;
  page: number;
}

export interface ApolloPeopleParams {
  query?: string;
  title?: FilterValue;
  seniority?: FilterValue;
  location?: string;
  company_domain?: FilterValue;
  limit: number;
  page: number;
}

export interface HunterDomainParams {
  domain: string;
  limit: number;
  seniority?: string;
  department?: string;
}

export interface HunterEmailParams {
  email?: string;
  domain?: string;
  first_name?: string;
  last_name?: string;
  linkedin_url?: string;
}

export type FilterValue = string | string[];

export interface CompanySearchParams {
  query?: string;
  domain?: FilterValue;
  industry?: FilterValue;
  employee_range?: FilterValue;
  revenue_range?: FilterValue;
  naics_code?: FilterValue;
  linkedin_industry?: FilterValue;
  country?: FilterValue;
  state?: FilterValue;
  exclude_domain?: string[];
  exclude_industry?: string[];
  exclude_employee_range?: string[];
  exclude_revenue_range?: string[];
  limit: number;
  offset: number;
}

export interface PeopleSearchParams {
  query?: string;
  title?: string;
  company?: string;
  company_domain?: FilterValue;
  city?: FilterValue;
  seniority?: FilterValue;
  department?: FilterValue;
  functional_area?: FilterValue;
  industry?: FilterValue;
  employee_range?: FilterValue;
  revenue_range?: FilterValue;
  naics_code?: FilterValue;
  linkedin_industry?: FilterValue;
  country?: FilterValue;
  state?: FilterValue;
  exclude_company_domain?: string[];
  exclude_country?: string[];
  exclude_state?: string[];
  exclude_industry?: string[];
  exclude_seniority?: string[];
  exclude_employee_range?: string[];
  limit: number;
  offset: number;
}

export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
}

export type ActionName =
  | "web.search"
  | "web.read_url"
  | "gtm.search_companies"
  | "gtm.search_people"
  | "gtm.apollo_companies"
  | "gtm.apollo_people"
  | "gtm.hunter_domain"
  | "gtm.hunter_email";

export type ActionProvider = SearchProvider | ReadProvider | "moltsets" | "apollo" | "hunter";

export interface ActionDefinition<P> {
  name: ActionName;
  provider: ActionProvider;
  description: string;
  parameters: JsonSchema;
  parse(input: unknown): P;
}

function validation(message: string): AppError {
  return new AppError("E_VALIDATION", message);
}

const EMPLOYEE_RANGES = ["1-10", "11-20", "21-50", "51-200", "201-500", "501-1000", "1001-5000", "5001+"] as const;
const REVENUE_RANGES = [
  "Below $500k",
  "$500k - $1M",
  "$1M - $5M",
  "$5M - $10M",
  "$10M - $20M",
  "$20M - $50M",
  "Above $50M",
] as const;
const INDUSTRIES = [
  "Professional and Business Services",
  "Information Technology",
  "Manufacturing",
  "Retail",
  "Health and Pharmaceuticals",
  "Creative Arts and Entertainment",
  "Construction",
  "Marketing & Advertising",
  "Finance and Banking",
  "Tourism and Hospitality",
  "Non-Profit and Social Services",
  "Food and Beverage",
  "Real Estate",
  "Education",
  "Transportation and Logistics",
  "Media and Publishing",
  "Energy",
  "Government and Public Administration",
  "Automotive",
  "Telecommunications",
  "Agriculture",
  "Utilities",
] as const;

const MAX_FILTER_VALUES = 25;
const MAX_FILTER_CHARS = 200;

function providerParam<T extends string>(value: unknown, allowed: readonly T[], fallback: T, field: string): T {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw validation(`${field} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

const searchAction: ActionDefinition<SearchParams> = {
  name: "web.search",
  provider: "tavily",
  description:
    "Search the public web and return a bounded list of results (title, URL, snippet, content, score). " +
    "Use for discovery and research. Does not fetch full page content. " +
    "Choose a provider with the provider field; tavily is the default.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query. Must be non-empty." },
      max_results: {
        type: "integer",
        minimum: 1,
        maximum: 10,
        description: "Number of results to return. Defaults to 5; maximum 10.",
      },
      search_depth: {
        type: "string",
        enum: ["basic", "advanced"],
        description: "Search depth hint. Used by Tavily and Linkup; other providers ignore it.",
      },
      provider: {
        type: "string",
        enum: [...SEARCH_PROVIDERS],
        description: "Search provider. Defaults to tavily.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  parse(input: unknown): SearchParams {
    if (!isRecord(input)) throw validation("search input must be an object");
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (!query) throw validation("query is required and must be a non-empty string");
    if (query.length > 500) throw validation("query must be 500 characters or fewer");

    let maxResults = 5;
    if (input.max_results !== undefined) {
      if (!Number.isInteger(input.max_results) || (input.max_results as number) < 1 || (input.max_results as number) > 10) {
        throw validation("max_results must be an integer between 1 and 10");
      }
      maxResults = input.max_results as number;
    }

    let depth: "basic" | "advanced" = "basic";
    if (input.search_depth !== undefined) {
      if (input.search_depth !== "basic" && input.search_depth !== "advanced") {
        throw validation('search_depth must be "basic" or "advanced"');
      }
      depth = input.search_depth;
    }

    const provider = providerParam(input.provider, SEARCH_PROVIDERS, "tavily", "provider");
    return { query, max_results: maxResults, search_depth: depth, provider };
  },
};

const readUrlAction: ActionDefinition<ReadParams> = {
  name: "web.read_url",
  provider: "jina",
  description:
    "Extract readable content from a known public HTTP(S) URL. " +
    "Returns the page title, description, main content and final URL. " +
    "Choose a provider with the provider field; jina is the default.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute public http:// or https:// URL to read." },
      provider: {
        type: "string",
        enum: [...READ_PROVIDERS],
        description: "Read provider. Defaults to jina.",
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
  parse(input: unknown): ReadParams {
    if (!isRecord(input)) throw validation("read_url input must be an object");
    const url = assertPublicHttpUrl(input.url);
    const provider = providerParam(input.provider, READ_PROVIDERS, "jina", "provider");
    return { url: url.href, provider };
  },
};

function filterString(value: unknown, field: string): string {
  if (typeof value !== "string") throw validation(`${field} must be a string or an array of strings`);
  const trimmed = value.trim();
  if (!trimmed) throw validation(`${field} must not be empty`);
  if (trimmed.length > MAX_FILTER_CHARS) {
    throw validation(`${field} values must be ${MAX_FILTER_CHARS} characters or fewer`);
  }
  return trimmed;
}

function filterValue(value: unknown, field: string): FilterValue | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    if (value.length === 0) throw validation(`${field} must not be an empty array`);
    if (value.length > MAX_FILTER_VALUES) throw validation(`${field} accepts at most ${MAX_FILTER_VALUES} values`);
    return value.map((item) => filterString(item, field));
  }
  return filterString(value, field);
}

function enumFilter(value: unknown, field: string, allowed: readonly string[]): FilterValue | undefined {
  const parsed = filterValue(value, field);
  if (parsed === undefined) return undefined;
  for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
    if (!allowed.includes(item)) throw validation(`${field} must be one of: ${allowed.join(", ")}`);
  }
  return parsed;
}

function naicsFilter(value: unknown): FilterValue | undefined {
  const parsed = filterValue(value, "naics_code");
  if (parsed === undefined) return undefined;
  for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
    if (!/^\d{2,6}$/.test(item)) throw validation("naics_code values must be 2-6 digit NAICS codes");
  }
  return parsed;
}

function exclusionList(value: unknown, field: string): string[] | undefined {
  const parsed = filterValue(value, field);
  if (parsed === undefined) return undefined;
  return Array.isArray(parsed) ? parsed : [parsed];
}

function limitParam(value: unknown): number {
  if (value === undefined) return 10;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 10) {
    throw validation("limit must be an integer between 1 and 10");
  }
  return value as number;
}

function offsetParam(value: unknown): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 10000) {
    throw validation("offset must be an integer between 0 and 10000");
  }
  return value as number;
}

function pageParams(input: Record<string, unknown>): { limit: number; offset: number } {
  const limit = limitParam(input.limit);
  const offset = offsetParam(input.offset);
  if (offset + limit > 10000) throw validation("offset + limit cannot exceed 10000");
  return { limit, offset };
}

function limitParam100(value: unknown): number {
  if (value === undefined) return 10;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 100) {
    throw validation("limit must be an integer between 1 and 100");
  }
  return value as number;
}

function pageParam(value: unknown): number {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 500) {
    throw validation("page must be an integer between 1 and 500");
  }
  return value as number;
}

function domainParam(value: unknown, field: string): string {
  const raw = filterString(value, field);
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname.includes(".")) {
      throw new Error("invalid domain");
    }
    return url.hostname;
  } catch {
    throw validation(`${field} must be a valid domain, e.g. vercel.com`);
  }
}

/** Apollo expects ranges formatted like "51,200". */
function apolloRange(value: unknown): FilterValue | undefined {
  const parsed = filterValue(value, "employee_range");
  if (parsed === undefined) return undefined;
  for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
    if (!/^\d{1,6}(,\d{0,6})?$/.test(item)) {
      throw validation('employee_range must look like "51,200" (comma-separated bounds)');
    }
  }
  return parsed;
}

const COMPANY_FILTER_KEYS = [
  "query",
  "domain",
  "industry",
  "employee_range",
  "revenue_range",
  "naics_code",
  "linkedin_industry",
  "country",
  "state",
] as const;

const searchCompaniesAction: ActionDefinition<CompanySearchParams> = {
  name: "gtm.search_companies",
  provider: "moltsets",
  description:
    "Search MoltSets' B2B company database by name, exact domain, industry, employee range, revenue range, " +
    "NAICS code, LinkedIn industry or location. Returns domain, size, revenue range, location and LinkedIn URL. " +
    "Use for account research and ICP lists. At most one call per request.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Company name free-text search. Use domain for a known company." },
      domain: { type: "string", description: "Exact company domain, e.g. vercel.com. URLs are normalized." },
      industry: { type: "string", enum: [...INDUSTRIES], description: "Exact industry bucket." },
      employee_range: { type: "string", enum: [...EMPLOYEE_RANGES], description: "Employee count band." },
      revenue_range: { type: "string", enum: [...REVENUE_RANGES], description: "Revenue band." },
      naics_code: { type: "string", description: "2-6 digit NAICS code." },
      linkedin_industry: { type: "string", description: "Exact LinkedIn industry label." },
      country: { type: "string", description: "Full English country name." },
      state: { type: "string", description: "Full state/region name or abbreviation." },
      exclude_domain: {
        type: "array",
        items: { type: "string" },
        maxItems: 25,
        description: "Domains to suppress, e.g. existing customers or vendors.",
      },
      exclude_industry: { type: "array", items: { type: "string" }, maxItems: 25 },
      exclude_employee_range: {
        type: "array",
        items: { type: "string", enum: [...EMPLOYEE_RANGES] },
        maxItems: 25,
      },
      exclude_revenue_range: {
        type: "array",
        items: { type: "string", enum: [...REVENUE_RANGES] },
        maxItems: 25,
      },
      limit: { type: "integer", minimum: 1, maximum: 10, description: "Results per page. Defaults to 10; maximum 10." },
      offset: { type: "integer", minimum: 0, maximum: 10000, description: "Results to skip for pagination." },
    },
    required: [],
    additionalProperties: false,
  },
  parse(input: unknown): CompanySearchParams {
    if (!isRecord(input)) throw validation("search_companies input must be an object");

    const params: Omit<CompanySearchParams, "limit" | "offset"> = {
      query: input.query === undefined ? undefined : filterString(input.query, "query"),
      domain: filterValue(input.domain, "domain"),
      industry: enumFilter(input.industry, "industry", INDUSTRIES),
      employee_range: enumFilter(input.employee_range, "employee_range", EMPLOYEE_RANGES),
      revenue_range: enumFilter(input.revenue_range, "revenue_range", REVENUE_RANGES),
      naics_code: naicsFilter(input.naics_code),
      linkedin_industry: filterValue(input.linkedin_industry, "linkedin_industry"),
      country: filterValue(input.country, "country"),
      state: filterValue(input.state, "state"),
      exclude_domain: exclusionList(input.exclude_domain, "exclude_domain"),
      exclude_industry: exclusionList(input.exclude_industry, "exclude_industry"),
      exclude_employee_range: exclusionList(input.exclude_employee_range, "exclude_employee_range"),
      exclude_revenue_range: exclusionList(input.exclude_revenue_range, "exclude_revenue_range"),
    };

    if (!COMPANY_FILTER_KEYS.some((key) => params[key] !== undefined)) {
      throw validation(`provide at least one positive filter: ${COMPANY_FILTER_KEYS.join(", ")}`);
    }

    return { ...params, ...pageParams(input) };
  },
};

const PEOPLE_FILTER_KEYS = [
  "query",
  "title",
  "company",
  "company_domain",
  "city",
  "seniority",
  "department",
  "functional_area",
  "industry",
  "employee_range",
  "revenue_range",
  "naics_code",
  "linkedin_industry",
  "country",
  "state",
] as const;

const searchPeopleAction: ActionDefinition<PeopleSearchParams> = {
  name: "gtm.search_people",
  provider: "moltsets",
  description:
    "Search MoltSets' B2B people database by name, title, company or domain, seniority, department, location, " +
    "industry or company size. Returns title, seniority, LinkedIn URL, business email and company. " +
    "Use for finding contacts at an account. At most one call per request.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Person name free-text search." },
      title: { type: "string", description: "Job title match, e.g. Head of Marketing." },
      company: { type: "string", description: "Company name." },
      company_domain: { type: "string", description: "Exact company domain, e.g. vercel.com." },
      city: { type: "string", description: "City name." },
      seniority: { type: "string", description: "Seniority level, e.g. Manager, Director, VP." },
      department: { type: "string", description: "Department. Do not combine with functional_area." },
      functional_area: { type: "string", description: "Functional area. Do not combine with department." },
      industry: { type: "string", enum: [...INDUSTRIES], description: "Exact company industry bucket." },
      employee_range: { type: "string", enum: [...EMPLOYEE_RANGES], description: "Company employee count band." },
      revenue_range: { type: "string", enum: [...REVENUE_RANGES], description: "Company revenue band." },
      naics_code: { type: "string", description: "2-6 digit NAICS code." },
      linkedin_industry: { type: "string", description: "Exact LinkedIn industry label." },
      country: { type: "string", description: "Full English country name." },
      state: { type: "string", description: "Full state/region name or abbreviation." },
      exclude_company_domain: { type: "array", items: { type: "string" }, maxItems: 25 },
      exclude_country: { type: "array", items: { type: "string" }, maxItems: 25 },
      exclude_state: { type: "array", items: { type: "string" }, maxItems: 25 },
      exclude_industry: { type: "array", items: { type: "string" }, maxItems: 25 },
      exclude_seniority: { type: "array", items: { type: "string" }, maxItems: 25 },
      exclude_employee_range: {
        type: "array",
        items: { type: "string", enum: [...EMPLOYEE_RANGES] },
        maxItems: 25,
      },
      limit: { type: "integer", minimum: 1, maximum: 10, description: "Results per page. Defaults to 10; maximum 10." },
      offset: { type: "integer", minimum: 0, maximum: 10000, description: "Results to skip for pagination." },
    },
    required: [],
    additionalProperties: false,
  },
  parse(input: unknown): PeopleSearchParams {
    if (!isRecord(input)) throw validation("search_people input must be an object");

    if (input.department !== undefined && input.functional_area !== undefined) {
      throw validation("provide either department or functional_area, not both");
    }

    const params: Omit<PeopleSearchParams, "limit" | "offset"> = {
      query: input.query === undefined ? undefined : filterString(input.query, "query"),
      title: input.title === undefined ? undefined : filterString(input.title, "title"),
      company: input.company === undefined ? undefined : filterString(input.company, "company"),
      company_domain: filterValue(input.company_domain, "company_domain"),
      city: filterValue(input.city, "city"),
      seniority: filterValue(input.seniority, "seniority"),
      department: filterValue(input.department, "department"),
      functional_area: filterValue(input.functional_area, "functional_area"),
      industry: enumFilter(input.industry, "industry", INDUSTRIES),
      employee_range: enumFilter(input.employee_range, "employee_range", EMPLOYEE_RANGES),
      revenue_range: enumFilter(input.revenue_range, "revenue_range", REVENUE_RANGES),
      naics_code: naicsFilter(input.naics_code),
      linkedin_industry: filterValue(input.linkedin_industry, "linkedin_industry"),
      country: filterValue(input.country, "country"),
      state: filterValue(input.state, "state"),
      exclude_company_domain: exclusionList(input.exclude_company_domain, "exclude_company_domain"),
      exclude_country: exclusionList(input.exclude_country, "exclude_country"),
      exclude_state: exclusionList(input.exclude_state, "exclude_state"),
      exclude_industry: exclusionList(input.exclude_industry, "exclude_industry"),
      exclude_seniority: exclusionList(input.exclude_seniority, "exclude_seniority"),
      exclude_employee_range: exclusionList(input.exclude_employee_range, "exclude_employee_range"),
    };

    if (!PEOPLE_FILTER_KEYS.some((key) => params[key] !== undefined)) {
      throw validation(`provide at least one positive filter: ${PEOPLE_FILTER_KEYS.join(", ")}`);
    }

    return { ...params, ...pageParams(input) };
  },
};

const APOLLO_COMPANY_FILTER_KEYS = ["query", "domain", "location", "employee_range", "industry"] as const;

const apolloCompaniesAction: ActionDefinition<ApolloCompanyParams> = {
  name: "gtm.apollo_companies",
  provider: "apollo",
  description:
    "Search Apollo's B2B organization database by name, domain, location, employee range or industry. " +
    "Returns name, domain, industry, estimated employees, location and LinkedIn URL. " +
    "Use as an alternative account source to MoltSets.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Organization name or keyword." },
      domain: { type: "string", description: "Company domain, e.g. vercel.com." },
      location: { type: "string", description: "Headquarters location, e.g. United States or California." },
      employee_range: { type: "string", description: 'Employee band as comma-separated bounds, e.g. "51,200".' },
      industry: { type: "string", description: "Industry keyword." },
      limit: { type: "integer", minimum: 1, maximum: 100, description: "Results per page. Defaults to 10." },
      page: { type: "integer", minimum: 1, maximum: 500, description: "Page number. Defaults to 1." },
    },
    required: [],
    additionalProperties: false,
  },
  parse(input: unknown): ApolloCompanyParams {
    if (!isRecord(input)) throw validation("apollo_companies input must be an object");
    const params = {
      query: input.query === undefined ? undefined : filterString(input.query, "query"),
      domain: filterValue(input.domain, "domain"),
      location: input.location === undefined ? undefined : filterString(input.location, "location"),
      employee_range: apolloRange(input.employee_range),
      industry: input.industry === undefined ? undefined : filterString(input.industry, "industry"),
    };
    if (!APOLLO_COMPANY_FILTER_KEYS.some((key) => params[key] !== undefined)) {
      throw validation(`provide at least one filter: ${APOLLO_COMPANY_FILTER_KEYS.join(", ")}`);
    }
    return { ...params, limit: limitParam100(input.limit), page: pageParam(input.page) };
  },
};

const APOLLO_PEOPLE_FILTER_KEYS = ["query", "title", "seniority", "location", "company_domain"] as const;

const apolloPeopleAction: ActionDefinition<ApolloPeopleParams> = {
  name: "gtm.apollo_people",
  provider: "apollo",
  description:
    "Search Apollo's B2B people database by keyword, title, seniority, location or company domain. " +
    "Returns name, title, seniority, location, LinkedIn URL and company. " +
    "Apollo search does not return email addresses; use Hunter for emails.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Person name or keyword." },
      title: { type: "string", description: "Job title, e.g. Head of Marketing." },
      seniority: { type: "string", description: "Seniority level, e.g. director, vp, c_suite." },
      location: { type: "string", description: "Person location, e.g. United States." },
      company_domain: { type: "string", description: "Company domain, e.g. vercel.com." },
      limit: { type: "integer", minimum: 1, maximum: 100, description: "Results per page. Defaults to 10." },
      page: { type: "integer", minimum: 1, maximum: 500, description: "Page number. Defaults to 1." },
    },
    required: [],
    additionalProperties: false,
  },
  parse(input: unknown): ApolloPeopleParams {
    if (!isRecord(input)) throw validation("apollo_people input must be an object");
    const params = {
      query: input.query === undefined ? undefined : filterString(input.query, "query"),
      title: filterValue(input.title, "title"),
      seniority: filterValue(input.seniority, "seniority"),
      location: input.location === undefined ? undefined : filterString(input.location, "location"),
      company_domain: filterValue(input.company_domain, "company_domain"),
    };
    if (!APOLLO_PEOPLE_FILTER_KEYS.some((key) => params[key] !== undefined)) {
      throw validation(`provide at least one filter: ${APOLLO_PEOPLE_FILTER_KEYS.join(", ")}`);
    }
    return { ...params, limit: limitParam100(input.limit), page: pageParam(input.page) };
  },
};

const HUNTER_SENIORITIES = ["junior", "senior", "executive"] as const;

const hunterDomainAction: ActionDefinition<HunterDomainParams> = {
  name: "gtm.hunter_domain",
  provider: "hunter",
  description:
    "Find business email addresses associated with a company domain using Hunter. " +
    "Returns name, title, seniority, LinkedIn URL, business email, verification status and confidence score. " +
    "Use when verified emails are required.",
  parameters: {
    type: "object",
    properties: {
      domain: { type: "string", description: "Company domain, e.g. vercel.com." },
      limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum emails. Defaults to 10." },
      seniority: { type: "string", enum: [...HUNTER_SENIORITIES], description: "Filter by seniority." },
      department: { type: "string", description: "Filter by department, e.g. engineering, marketing." },
    },
    required: ["domain"],
    additionalProperties: false,
  },
  parse(input: unknown): HunterDomainParams {
    if (!isRecord(input)) throw validation("hunter_domain input must be an object");
    return {
      domain: domainParam(input.domain, "domain"),
      limit: limitParam100(input.limit),
      seniority: input.seniority === undefined ? undefined : filterString(input.seniority, "seniority"),
      department: input.department === undefined ? undefined : filterString(input.department, "department"),
    };
  },
};

const hunterEmailAction: ActionDefinition<HunterEmailParams> = {
  name: "gtm.hunter_email",
  provider: "hunter",
  description:
    "Find one person's business email (domain + name or LinkedIn URL) or verify an existing email address with Hunter. " +
    "Returns the email, verification status and confidence score.",
  parameters: {
    type: "object",
    properties: {
      email: { type: "string", description: "Email address to verify. When set, other fields are ignored." },
      domain: { type: "string", description: "Company domain for email lookup." },
      first_name: { type: "string", description: "Person's first name." },
      last_name: { type: "string", description: "Person's last name." },
      linkedin_url: { type: "string", description: "Person's LinkedIn profile URL." },
    },
    required: [],
    additionalProperties: false,
  },
  parse(input: unknown): HunterEmailParams {
    if (!isRecord(input)) throw validation("hunter_email input must be an object");

    if (input.email !== undefined) {
      return { email: filterString(input.email, "email") };
    }

    const domain = input.domain === undefined ? undefined : domainParam(input.domain, "domain");
    const first_name = input.first_name === undefined ? undefined : filterString(input.first_name, "first_name");
    const last_name = input.last_name === undefined ? undefined : filterString(input.last_name, "last_name");
    const linkedin_url = input.linkedin_url === undefined ? undefined : filterString(input.linkedin_url, "linkedin_url");

    if (!domain && !linkedin_url) {
      throw validation("provide email, or domain/linkedin_url to find an address");
    }
    if (!linkedin_url && !(first_name && last_name)) {
      throw validation("provide first_name and last_name, or a linkedin_url, to find an address");
    }
    return { domain, first_name, last_name, linkedin_url };
  },
};

export const ACTIONS = {
  "web.search": searchAction,
  "web.read_url": readUrlAction,
  "gtm.search_companies": searchCompaniesAction,
  "gtm.search_people": searchPeopleAction,
  "gtm.apollo_companies": apolloCompaniesAction,
  "gtm.apollo_people": apolloPeopleAction,
  "gtm.hunter_domain": hunterDomainAction,
  "gtm.hunter_email": hunterEmailAction,
} as const;

export function listActions(): Array<{
  name: string;
  description: string;
  provider: string;
  parameters: JsonSchema;
}> {
  return Object.values(ACTIONS).map((action) => ({
    name: action.name,
    description: action.description,
    provider: action.provider,
    parameters: action.parameters,
  }));
}
