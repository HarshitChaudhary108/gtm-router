/**
 * Live smoke test against the real providers. Requires .env with real keys.
 * Run: npm run smoke
 */
import { llmConfigured, loadEnv, parseConfig } from "../src/config.js";
import { executeAction, type ActionResult, type EngineDeps } from "../src/engine.js";
import { createLlmClient } from "../src/llm.js";
import { route } from "../src/router.js";
import type { CompaniesData, PageData, PeopleData, SearchData } from "../src/types.js";

loadEnv();
const config = parseConfig();
let failures = 0;

const engineDeps: EngineDeps = {
  tavilyKey: config.tavilyKey,
  jinaKey: config.jinaKey,
  moltsetsKey: config.moltsetsKey,
  parallelKey: config.parallelKey,
  youKey: config.youKey,
  linkupKey: config.linkupKey,
  firecrawlKey: config.firecrawlKey,
  serperKey: config.serperKey,
  apifyKey: config.apifyKey,
  browserbaseKey: config.browserbaseKey,
  apolloKey: config.apolloKey,
  hunterKey: config.hunterKey,
  maxMoltResults: config.maxMoltResults,
  moltsetsTimeoutMs: config.moltsetsTimeoutMs,
  apifyTimeoutMs: config.apifyTimeoutMs,
};

const presence = [
  ["tavily", config.tavilyKey],
  ["jina", config.jinaKey],
  ["moltsets", config.moltsetsKey],
  ["parallel", config.parallelKey],
  ["you", config.youKey],
  ["linkup", config.linkupKey],
  ["firecrawl", config.firecrawlKey],
  ["serper", config.serperKey],
  ["apify", config.apifyKey],
  ["browserbase", config.browserbaseKey],
  ["apollo", config.apolloKey],
  ["hunter", config.hunterKey],
] as const;

console.log("== configuration ==");
console.log(presence.map(([name, key]) => `${name}=${Boolean(key)}`).join(" "));
console.log(`llm=${llmConfigured(config)}${config.llmModel ? ` model=${config.llmModel}` : ""}`);

if (!config.tavilyKey) {
  console.error("TAVILY_API_KEY is missing; cannot continue.");
  process.exit(1);
}

console.log("\n== Tavily web.search ==");
const search = await executeAction(
  "web.search",
  { query: "Acme company official website", max_results: 3 },
  { tavilyKey: config.tavilyKey },
);
if (!search.ok) {
  failures++;
  console.error(`FAILED ${search.error?.code}: ${search.error?.message}`);
} else {
  const data = search.data as SearchData;
  console.log(`ok in ${search.record.duration_ms}ms — ${data.results.length} result(s)`);
  data.results.forEach((result, index) => {
    console.log(`  ${index + 1}. ${result.title ?? "(no title)"}`);
    console.log(`     ${result.url}`);
  });
}

console.log("\n== Jina Reader web.read_url ==");
const read = await executeAction(
  "web.read_url",
  { url: "https://example.com" },
  { jinaKey: config.jinaKey },
);
if (!read.ok) {
  failures++;
  console.error(`FAILED ${read.error?.code}: ${read.error?.message}`);
} else {
  const page = read.data as PageData;
  console.log(`ok in ${read.record.duration_ms}ms — ${page.title ?? "(no title)"}, ${page.content_length} characters`);
  console.log(`  preview: ${page.content.slice(0, 160).replace(/\s+/g, " ")}…`);
}

console.log("\n== MoltSets outmate.search_people ==");
// Free-tier searches are metered per record, so this asks for the smallest page.
if (!config.moltsetsKey) {
  console.log("Skipped: set MOLTSETS_API_KEY to exercise the MoltSets adapters.");
} else {
  const people = await executeAction(
    "outmate.search_people",
    { company_domain: "vercel.com", seniority: "VP", limit: 1 },
    { moltsetsKey: config.moltsetsKey },
  );
  if (!people.ok) {
    failures++;
    console.error(`FAILED ${people.error?.code}: ${people.error?.message}`);
  } else {
    const data = people.data as PeopleData;
    console.log(`ok in ${people.record.duration_ms}ms — ${data.results.length} of ${data.total} matching people`);
    data.results.forEach((person) => {
      console.log(`  ${person.name ?? "(no name)"} — ${person.title ?? "(no title)"} · ${person.company_name ?? "—"}`);
    });
  }
}

console.log("\n== additional providers (one minimal call each) ==");
function describeData(data: unknown): string {
  if (typeof data !== "object" || data === null) return "";
  const record = data as Record<string, unknown>;
  if (Array.isArray(record.results)) return `— ${record.results.length} result(s)`;
  if (typeof record.content_length === "number") return `— ${record.content_length} chars`;
  return "";
}

const providerChecks: Array<{ name: string; configured: boolean; run: () => Promise<ActionResult> }> = [
  {
    name: "parallel",
    configured: Boolean(config.parallelKey),
    run: () => executeAction("web.search", { query: "vercel pricing", max_results: 1, provider: "parallel" }, engineDeps),
  },
  {
    name: "you",
    configured: Boolean(config.youKey),
    run: () => executeAction("web.search", { query: "vercel pricing", max_results: 1, provider: "you" }, engineDeps),
  },
  {
    name: "linkup",
    configured: Boolean(config.linkupKey),
    run: () => executeAction("web.search", { query: "vercel pricing", max_results: 1, provider: "linkup" }, engineDeps),
  },
  {
    name: "firecrawl",
    configured: Boolean(config.firecrawlKey),
    run: () => executeAction("web.search", { query: "vercel pricing", max_results: 1, provider: "firecrawl" }, engineDeps),
  },
  {
    name: "serper",
    configured: Boolean(config.serperKey),
    run: () => executeAction("web.search", { query: "vercel pricing", max_results: 1, provider: "serper" }, engineDeps),
  },
  {
    name: "apify",
    configured: Boolean(config.apifyKey),
    run: () => executeAction("web.search", { query: "vercel pricing", max_results: 1, provider: "apify" }, engineDeps),
  },
  {
    name: "browserbase",
    configured: Boolean(config.browserbaseKey),
    run: () => executeAction("web.read_url", { url: "https://example.com", provider: "browserbase" }, engineDeps),
  },
  {
    name: "apollo",
    configured: Boolean(config.apolloKey),
    run: () => executeAction("outmate.apollo_people", { company_domain: "vercel.com", limit: 1 }, engineDeps),
  },
  {
    name: "hunter",
    configured: Boolean(config.hunterKey),
    run: () => executeAction("outmate.hunter_domain", { domain: "vercel.com", limit: 1 }, engineDeps),
  },
];

for (const check of providerChecks) {
  if (!check.configured) {
    console.log(`- ${check.name}: skipped (no key)`);
    continue;
  }
  const result = await check.run();
  if (!result.ok) {
    failures++;
    console.log(`- ${check.name}: FAILED ${result.error?.code}: ${result.error?.message}`);
  } else {
    console.log(`- ${check.name}: ok (${result.record.duration_ms}ms) ${describeData(result.data)}`);
  }
}

console.log("\n== LLM routing ==");
if (!llmConfigured(config) || !config.llmKey) {
  console.log("Skipped: set LLM_API_KEY and LLM_MODEL to exercise natural-language routing.");
} else {
  const llm = createLlmClient({
    apiKey: config.llmKey,
    baseUrl: config.llmBaseUrl,
    model: config.llmModel,
    timeoutMs: config.llmTimeoutMs,
  });
  const prompt =
    process.argv[2] ?? "Research Vercel, find its official pricing page, and extract the page content.";
  console.log(`input: ${prompt}`);
  const result = await route(prompt, {
    config,
    requestId: "req_smoke",
    llm,
    execute: (name, input) => executeAction(name, input, engineDeps),
  });
  console.log(`status=${result.status} duration=${result.meta.duration_ms}ms`);
  console.log(
    `trace: ${result.execution.map((step) => `${step.action}:${step.status}(${step.provider},${step.duration_ms}ms)`).join(" -> ") || "(no tools)"}`,
  );
  console.log(`answer: ${result.answer}`);
  if (result.data.page) {
    console.log(`page: ${result.data.page.url} (${result.data.page.content_length} chars)`);
  }
  if (result.data.companies.length > 0) {
    const companies = result.data.companies as CompaniesData["results"];
    console.log(`companies: ${companies.length}`);
    companies.slice(0, 5).forEach((company) => console.log(`  - ${company.name ?? company.domain ?? "—"}`));
  }
  if (result.data.people.length > 0) {
    const people = result.data.people as PeopleData["results"];
    console.log(`people: ${people.length}`);
    people.slice(0, 5).forEach((person) => console.log(`  - ${person.name ?? "—"} — ${person.title ?? "—"}`));
  }
  if (result.data.results.length > 0) {
    console.log("sources:");
    result.data.results.slice(0, 5).forEach((item) => console.log(`  - ${item.url}`));
  }
  if (result.status === "error") failures++;
}

if (failures > 0) {
  console.error(`\n${failures} smoke check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log("\nAll smoke checks passed.");
}
