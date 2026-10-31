import { searchApify } from "./adapters/apify.js";
import { searchApolloCompanies, searchApolloPeople, type ApolloDeps } from "./adapters/apollo.js";
import { readBrowserbase } from "./adapters/browserbase.js";
import { readFirecrawl, searchFirecrawl } from "./adapters/firecrawl.js";
import { findHunterEmail, searchHunterDomain, type HunterDeps } from "./adapters/hunter.js";
import { readUrl, type JinaDeps } from "./adapters/jina.js";
import { searchLinkup } from "./adapters/linkup.js";
import { searchCompanies, searchPeople, type MoltsetsDeps } from "./adapters/moltsets.js";
import { searchParallel } from "./adapters/parallel.js";
import { searchSerper } from "./adapters/serper.js";
import { searchWeb, type TavilyDeps } from "./adapters/tavily.js";
import { searchYou } from "./adapters/you.js";
import { LIMITS } from "./config.js";
import { AppError, toAppError } from "./errors.js";
import type { FetchLike } from "./http.js";
import { ACTIONS, type ActionName, type SearchProvider } from "./registry.js";
import type { CompaniesData, ExecutionStep, PageData, PeopleData, SearchData } from "./types.js";
import type { LookupFn } from "./url-safety.js";

export interface EngineDeps {
  tavilyKey?: string;
  jinaKey?: string;
  moltsetsKey?: string;
  parallelKey?: string;
  youKey?: string;
  linkupKey?: string;
  firecrawlKey?: string;
  serperKey?: string;
  apifyKey?: string;
  browserbaseKey?: string;
  apolloKey?: string;
  hunterKey?: string;
  fetchImpl?: FetchLike;
  lookup?: LookupFn;
  retryDelayMs?: number;
  maxResultChars?: number;
  maxPageChars?: number;
  maxMoltResults?: number;
  searchTimeoutMs?: number;
  readTimeoutMs?: number;
  moltsetsTimeoutMs?: number;
  apifyTimeoutMs?: number;
}

export interface ActionResult {
  ok: boolean;
  record: ExecutionStep;
  data?: SearchData | PageData | CompaniesData | PeopleData;
  error?: AppError;
}

function searchKey(provider: SearchProvider, deps: EngineDeps): string | undefined {
  switch (provider) {
    case "tavily":
      return deps.tavilyKey;
    case "parallel":
      return deps.parallelKey;
    case "you":
      return deps.youKey;
    case "linkup":
      return deps.linkupKey;
    case "firecrawl":
      return deps.firecrawlKey;
    case "serper":
      return deps.serperKey;
    case "apify":
      return deps.apifyKey;
  }
}

/** Validate input, dispatch to the action's provider adapter, and record the execution. */
export async function executeAction(name: ActionName, input: unknown, deps: EngineDeps): Promise<ActionResult> {
  const started = Date.now();
  let provider: string = ACTIONS[name].provider;

  try {
    let data: SearchData | PageData | CompaniesData | PeopleData;

    if (name === "web.search") {
      const params = ACTIONS["web.search"].parse(input);
      const searchProvider = params.provider ?? "tavily";
      provider = searchProvider;
      const shared = {
        apiKey: searchKey(searchProvider, deps),
        fetchImpl: deps.fetchImpl,
        retryDelayMs: deps.retryDelayMs,
        maxResultChars: deps.maxResultChars,
        timeoutMs: deps.searchTimeoutMs ?? LIMITS.searchTimeoutMs,
      };
      switch (searchProvider) {
        case "tavily":
          data = await searchWeb(params, shared as TavilyDeps);
          break;
        case "parallel":
          data = await searchParallel(params, shared);
          break;
        case "you":
          data = await searchYou(params, shared);
          break;
        case "linkup":
          data = await searchLinkup(params, shared);
          break;
        case "firecrawl":
          data = await searchFirecrawl(params, shared);
          break;
        case "serper":
          data = await searchSerper(params, shared);
          break;
        case "apify":
          data = await searchApify(params, {
            ...shared,
            timeoutMs: deps.apifyTimeoutMs ?? LIMITS.apifyTimeoutMs,
          });
          break;
      }
    } else if (name === "web.read_url") {
      const params = ACTIONS["web.read_url"].parse(input);
      const readProvider = params.provider ?? "jina";
      provider = readProvider;
      if (readProvider === "jina") {
        const jinaDeps: JinaDeps = {
          apiKey: deps.jinaKey,
          fetchImpl: deps.fetchImpl,
          lookup: deps.lookup,
          retryDelayMs: deps.retryDelayMs,
          maxChars: deps.maxPageChars,
          timeoutMs: deps.readTimeoutMs ?? LIMITS.readTimeoutMs,
        };
        data = await readUrl(params, jinaDeps);
      } else if (readProvider === "firecrawl") {
        data = await readFirecrawl(params, {
          apiKey: deps.firecrawlKey,
          fetchImpl: deps.fetchImpl,
          lookup: deps.lookup,
          retryDelayMs: deps.retryDelayMs,
          maxChars: deps.maxPageChars,
          timeoutMs: deps.readTimeoutMs ?? LIMITS.readTimeoutMs,
        });
      } else {
        data = await readBrowserbase(params, {
          apiKey: deps.browserbaseKey,
          fetchImpl: deps.fetchImpl,
          lookup: deps.lookup,
          retryDelayMs: deps.retryDelayMs,
          maxChars: deps.maxPageChars,
          timeoutMs: deps.readTimeoutMs ?? LIMITS.readTimeoutMs,
        });
      }
    } else if (name === "gtm.apollo_companies" || name === "gtm.apollo_people") {
      const params = ACTIONS[name].parse(input);
      const apolloDeps: ApolloDeps = {
        apiKey: deps.apolloKey,
        fetchImpl: deps.fetchImpl,
        retryDelayMs: deps.retryDelayMs,
        maxResults: params.limit,
        timeoutMs: deps.searchTimeoutMs ?? LIMITS.searchTimeoutMs,
      };
      data =
        name === "gtm.apollo_companies"
          ? await searchApolloCompanies(params as Parameters<typeof searchApolloCompanies>[0], apolloDeps)
          : await searchApolloPeople(params as Parameters<typeof searchApolloPeople>[0], apolloDeps);
    } else if (name === "gtm.hunter_domain" || name === "gtm.hunter_email") {
      const params = ACTIONS[name].parse(input);
      const hunterDeps: HunterDeps = {
        apiKey: deps.hunterKey,
        fetchImpl: deps.fetchImpl,
        retryDelayMs: deps.retryDelayMs,
        maxResults: "limit" in params ? params.limit : undefined,
        timeoutMs: deps.searchTimeoutMs ?? LIMITS.searchTimeoutMs,
      };
      data =
        name === "gtm.hunter_domain"
          ? await searchHunterDomain(params as Parameters<typeof searchHunterDomain>[0], hunterDeps)
          : await findHunterEmail(params as Parameters<typeof findHunterEmail>[0], hunterDeps);
    } else {
      const moltDeps: MoltsetsDeps = {
        apiKey: deps.moltsetsKey,
        fetchImpl: deps.fetchImpl,
        retryDelayMs: deps.retryDelayMs,
        maxResults: deps.maxMoltResults,
        timeoutMs: deps.moltsetsTimeoutMs ?? LIMITS.moltsetsTimeoutMs,
      };
      data =
        name === "gtm.search_companies"
          ? await searchCompanies(ACTIONS["gtm.search_companies"].parse(input), moltDeps)
          : await searchPeople(ACTIONS["gtm.search_people"].parse(input), moltDeps);
    }
    return {
      ok: true,
      data,
      record: { action: name, provider, status: "success", duration_ms: Date.now() - started },
    };
  } catch (err) {
    const error = toAppError(err);
    return {
      ok: false,
      error,
      record: {
        action: name,
        provider,
        status: "error",
        duration_ms: Date.now() - started,
        error_code: error.code,
      },
    };
  }
}
