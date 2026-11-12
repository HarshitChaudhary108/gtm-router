/**
 * Benchmark the providers whose keys you have put in .env: latency, reliability, a rough quality
 * score and an estimated cost. It only runs providers that have a key, makes a small fixed number
 * of calls (default 3 cases x 2 runs per provider, capped by --max-calls), and never prints a key.
 *
 *   npx tsx scripts/bench.ts --dry                    what would run, and which keys are missing
 *   npx tsx scripts/bench.ts                          run everything that has a key
 *   npx tsx scripts/bench.ts --only tavily,exa --runs 3 --delay 1500
 *   npx tsx scripts/bench.ts --only tavily,jina --runs 1 --rows data/bench-rows.csv   also save every returned row
 *
 * Results are written to data/bench-results.json (git-ignored).
 *
 * Quality is deliberately simple and stated per case: does the answer contain facts that are well
 * known and stable (for example that Stripe was founded by the Collisons)? It says whether a
 * provider returns the right thing for easy questions, not how it does on your hard ones.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { loadEnv, parseConfig } from "../src/config.js";
import { executeAction, type EngineDeps } from "../src/engine.js";
import { sharedKey, sharedMeta } from "../src/keys.js";
import { ToolCatalog } from "../src/tools.js";

loadEnv();

interface Case {
  label: string;
  input: Record<string, unknown>;
  /** All of these must appear (case-insensitive) for a full score. Empty: any non-empty result counts. */
  expect?: string[];
  /** Any one of these is enough (used for verification results, whose wording differs per provider). */
  expectAny?: string[];
}

interface Target {
  id: string;
  category: string;
  /** Key slot that has to be present. */
  slot: string;
  action: string;
  cases: Case[];
  /** No quality check: only reliability and latency (the user's own CRM data is unknown to us). */
  latencyOnly?: boolean;
}

const WEB: Case[] = [
  { label: "who founded Stripe", input: { query: "Who founded Stripe?", max_results: 5 }, expect: ["collison"] },
  { label: "Stripe pricing page", input: { query: "Stripe pricing page", max_results: 5 }, expect: ["stripe.com"] },
  { label: "Figma founders", input: { query: "Who are the founders of Figma?", max_results: 5 }, expect: ["dylan field"] },
];
const READ: Case[] = [
  { label: "example.com", input: { url: "https://example.com" }, expect: ["example domain"] },
  { label: "python.org", input: { url: "https://www.python.org" }, expect: ["python"] },
];
const web = (id: string, slot: string, provider: string): Target => ({
  id, category: "Web search", slot, action: "web.search", cases: WEB.map((c) => ({ ...c, input: { ...c.input, provider } })),
});
const read = (id: string, slot: string, provider: string): Target => ({
  id, category: "Page read", slot, action: "web.read_url", cases: READ.map((c) => ({ ...c, input: { ...c.input, provider } })),
});
const STRIPE = (extra: Record<string, unknown> = {}): Case[] => [{ label: "stripe.com", input: { domain: "stripe.com", ...extra }, expect: ["stripe"] }];
const PERSON = (input: Record<string, unknown>): Case[] => [{ label: "Patrick Collison at stripe.com", input, expect: ["stripe.com"] }];
const BAD_EMAILS: Case[] = [
  { label: "disposable domain", input: { email: "test@mailinator.com" }, expectAny: ["disposable", "undeliverable", "invalid", "risky", "unknown", "spam"] },
  { label: "domain that does not exist", input: { email: "someone@zzqq-no-such-domain-12345.com" }, expectAny: ["undeliverable", "invalid", "no_mx", "mx", "not valid", "unknown", "reject"] },
];

const TARGETS: Target[] = [
  web("tavily", "tavily", "tavily"),
  { id: "exa", category: "Web search", slot: "exa", action: "custom.exa_search", cases: WEB.map((c) => ({ ...c, input: { query: c.input.query, num_results: 5 } })) },
  web("parallel", "parallel", "parallel"),
  web("you", "you", "you"),
  web("linkup", "linkup", "linkup"),
  web("firecrawl-search", "firecrawl", "firecrawl"),
  web("serper", "serper", "serper"),
  web("apify", "apify", "apify"),
  read("jina", "jina", "jina"),
  read("firecrawl-read", "firecrawl", "firecrawl"),
  read("browserbase", "browserbase", "browserbase"),
  { id: "moltsets-people", category: "People & contact", slot: "moltsets", action: "outmate.search_people", cases: [{ label: "CEO of stripe.com", input: { company_domain: "stripe.com", title: "CEO", limit: 3 }, expect: ["collison"] }] },
  { id: "apollo-people", category: "People & contact", slot: "apollo", action: "outmate.apollo_people", cases: [{ label: "CEO of stripe.com", input: { company_domain: "stripe.com", title: "CEO", limit: 3 }, expect: ["collison"] }] },
  { id: "hunter-domain", category: "People & contact", slot: "hunter", action: "outmate.hunter_domain", cases: STRIPE({ limit: 3 }) },
  { id: "prospeo", category: "People & contact", slot: "prospeo", action: "custom.prospeo_enrich_person", cases: PERSON({ first_name: "Patrick", last_name: "Collison", company_website: "stripe.com" }) },
  { id: "findymail", category: "People & contact", slot: "findymail", action: "custom.findymail_find", cases: PERSON({ name: "Patrick Collison", domain: "stripe.com" }) },
  { id: "moltsets-company", category: "Company data", slot: "moltsets", action: "outmate.search_companies", cases: STRIPE({ limit: 1 }) },
  { id: "apollo-company", category: "Company data", slot: "apollo", action: "outmate.apollo_companies", cases: STRIPE({ limit: 1 }) },
  { id: "ocean", category: "Company data", slot: "ocean", action: "custom.ocean_lookalike", cases: [{ label: "lookalikes of stripe.com", input: { domain: "stripe.com", limit: 3 }, expect: [] }] },
  { id: "crustdata", category: "Company data", slot: "crustdata", action: "custom.crustdata_company", cases: STRIPE() },
  { id: "dealroom", category: "Company data", slot: "dealroom", action: "custom.dealroom_match_company", cases: [{ label: "stripe.com", input: { website: "stripe.com" }, expect: ["stripe"] }] },
  { id: "builtwith", category: "Buying signals", slot: "builtwith", action: "custom.builtwith_domain", cases: [{ label: "stripe.com tech stack", input: { domain: "stripe.com" }, expect: [] }] },
  { id: "predictleads", category: "Buying signals", slot: "predictleads", action: "custom.predictleads_job_openings", cases: [{ label: "stripe.com jobs", input: { domain: "stripe.com", limit: 3 }, expect: [] }] },
  { id: "kickbox", category: "Verification", slot: "kickbox", action: "custom.kickbox_verify", cases: BAD_EMAILS },
  { id: "debounce", category: "Verification", slot: "debounce", action: "custom.debounce_verify", cases: BAD_EMAILS },
  { id: "findymail-verify", category: "Verification", slot: "findymail", action: "custom.findymail_verify", cases: BAD_EMAILS },
  { id: "hubspot", category: "CRM", slot: "hubspot", action: "custom.hubspot_search_companies", latencyOnly: true, cases: [{ label: "search 'stripe'", input: { query: "stripe", limit: 3 } }] },
  { id: "salesforce", category: "CRM", slot: "salesforce", action: "custom.salesforce_search_accounts", latencyOnly: true, cases: [{ label: "search 'stripe'", input: { name: "stripe" } }] },
];

/** Public prices and free allowances, collected from each provider's pricing pages and docs on 2026-11-12. Verify before relying on them. */
const PRICING: Record<string, { perCallUsd?: number; free: string }> = {
  tavily: { perCallUsd: 0.008, free: "1,000 credits a month" },
  exa: { perCallUsd: 0.007, free: "$20 on signup, then $10 a month" },
  parallel: { perCallUsd: 0.005, free: "$5 a month (about 5,000 searches); signup credit reported" },
  you: { perCallUsd: 0.005, free: "$100 on signup" },
  linkup: { perCallUsd: 0.005, free: "about $20 a month top-up (sources disagree)" },
  "firecrawl-search": { free: "1,000 credits a month" },
  "firecrawl-read": { free: "1,000 credits a month" },
  serper: { perCallUsd: 0.001, free: "2,500 queries, once" },
  apify: { free: "$5 a month of platform credit" },
  jina: { perCallUsd: 0.0005, free: "10M tokens per new key (non-commercial)" },
  browserbase: { free: "about 1 browser hour a month" },
  "moltsets-people": { free: "free plan reported (1,000 calls, 100 tokens)" },
  "moltsets-company": { free: "free plan reported (1,000 calls, 100 tokens)" },
  "apollo-people": { free: "free plan; API access on it unclear" },
  "apollo-company": { free: "free plan; API access on it unclear" },
  "hunter-domain": { free: "50 credits a month, API included" },
  prospeo: { free: "free plan has no API access" },
  findymail: { free: "10 finder + 10 verify credits, once" },
  "findymail-verify": { free: "10 finder + 10 verify credits, once" },
  ocean: { free: "trial reported (14 days, 200 credits); sources disagree" },
  crustdata: { free: "$20 starting credit reported; sources disagree" },
  dealroom: { free: "no free API; sales-led" },
  builtwith: { perCallUsd: 0.05, free: "Free API only (counts); Domain API is paid" },
  predictleads: { perCallUsd: 0.04, free: "about 100 calls a month reported" },
  kickbox: { perCallUsd: 0.01, free: "100 verifications" },
  debounce: { free: "100 credits, once" },
  hubspot: { free: "free developer test account" },
  salesforce: { free: "free Developer Edition org" },
};

// ---------------------------------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const opt = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const RUNS = Math.max(1, Number(opt("runs", "2")));
const DELAY = Math.max(0, Number(opt("delay", "1000")));
const MAX_CALLS = Math.max(1, Number(opt("max-calls", "8")));
const only = opt("only", "").split(",").map((s) => s.trim()).filter(Boolean);
const OUT = opt("out", "data/bench-results.json");
const ROWS = opt("rows", "");

const config = parseConfig(process.env);
const catalog = new ToolCatalog();
const slots = [...new Set(["tavily", "jina", "moltsets", "parallel", "you", "linkup", "firecrawl", "serper", "apify", "browserbase", "apollo", "hunter", ...catalog.keySlots()])];
const keys: Record<string, string> = {};
const meta: Record<string, Record<string, string>> = {};
for (const slot of slots) {
  const key = sharedKey(config, slot);
  if (key) keys[slot] = key;
  const extra = sharedMeta(config, slot);
  if (Object.keys(extra).length) meta[slot] = extra;
}
const deps: EngineDeps = {
  tavilyKey: keys.tavily, jinaKey: keys.jina, moltsetsKey: keys.moltsets, parallelKey: keys.parallel, youKey: keys.you,
  linkupKey: keys.linkup, firecrawlKey: keys.firecrawl, serperKey: keys.serper, apifyKey: keys.apify,
  browserbaseKey: keys.browserbase, apolloKey: keys.apollo, hunterKey: keys.hunter,
  extraKeys: keys, extraMeta: meta, tools: catalog,
};

// ---- raw rows (--rows) ---------------------------------------------------------------------------
const asRec = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const text = (v: unknown): string => (typeof v === "string" ? v : v === null || v === undefined ? "" : JSON.stringify(v));

/** One row per returned item: search hits, a page, or whatever list the provider sent back. */
function flatten(payload: unknown): Array<{ title: string; url: string; score: string; text: string }> {
  const rec = asRec(payload);
  const list = rec ? ["results", "companies", "people", "records", "candidates", "data"].map((k) => rec[k]).find(Array.isArray) : Array.isArray(payload) ? payload : undefined;
  if (Array.isArray(list)) {
    return list.map((item) => {
      const r = asRec(item);
      if (!r) return { title: "", url: "", score: "", text: text(item) };
      const body = r.content ?? r.snippet ?? r.tagline ?? r.description;
      return { title: text(r.title ?? r.name ?? r.company_name), url: text(r.url ?? r.domain ?? r.website), score: text(r.score), text: body !== undefined ? text(body) : JSON.stringify(r) };
    });
  }
  if (rec && typeof rec.content === "string") return [{ title: text(rec.title), url: text(rec.final_url ?? rec.url), score: "", text: rec.content }];
  return [{ title: "", url: "", score: "", text: JSON.stringify(payload) }];
}

// A cell that starts with = + - @ could run as a formula when the file is opened in a spreadsheet.
const csvCell = (v: unknown): string => {
  let t = text(v).replace(/\s+/g, " ").trim().slice(0, 500);
  if (/^[=+\-@]/.test(t)) t = `'${t}`;
  return `"${t.replace(/"/g, '""')}"`;
};
const rowsOut: string[][] = [];

const envName = (slot: string): string => `${slot.toUpperCase().replace(/-/g, "_")}_API_KEY`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const pct = (sorted: number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;

function score(c: Case, text: string): number | null {
  const t = text.toLowerCase();
  if (c.expectAny) return c.expectAny.some((w) => t.includes(w)) ? 1 : 0;
  if (!c.expect) return null;
  if (c.expect.length === 0) return text.length > 20 && !/^\[?\]?$|^null$/.test(text.trim()) ? 1 : 0;
  return c.expect.filter((w) => t.includes(w.toLowerCase())).length / c.expect.length;
}

const selected = TARGETS.filter((t) => only.length === 0 || only.includes(t.id) || only.includes(t.slot));
const runnable = selected.filter((t) => keys[t.slot]);
const missing = selected.filter((t) => !keys[t.slot]);

console.log(`\nProviders with a key: ${runnable.length} · without: ${missing.length}\n`);
for (const t of runnable) {
  const calls = Math.min(MAX_CALLS, t.cases.length * RUNS);
  console.log(`  RUN   ${t.id.padEnd(18)} ${t.category.padEnd(17)} ${calls} calls`);
}
for (const t of missing) console.log(`  SKIP  ${t.id.padEnd(18)} ${t.category.padEnd(17)} set ${envName(t.slot)}  (free: ${PRICING[t.id]?.free ?? "?"})`);

if (flag("dry") || runnable.length === 0) {
  if (runnable.length === 0) console.log("\nNo provider keys found in .env, so nothing was called. Add keys, then run again.");
  process.exit(0);
}

interface Row {
  id: string; category: string; calls: number; ok: number; firstMs: number; p50: number; p95: number; max: number;
  quality: number | null; estUsd: number | null; free: string; errors: string[];
}
const rows: Row[] = [];

for (const target of runnable) {
  const times: number[] = [];
  const scores: number[] = [];
  const errors: string[] = [];
  let ok = 0;
  let calls = 0;
  outer: for (let run = 0; run < RUNS; run++) {
    for (const c of target.cases) {
      if (calls >= MAX_CALLS) break outer;
      calls++;
      const started = performance.now();
      const result = await executeAction(target.action, c.input, deps).catch((e: unknown) => ({ ok: false, error: { code: "THROWN", message: String(e) }, data: undefined, custom: undefined }));
      const ms = performance.now() - started;
      times.push(ms);
      if (result.ok) {
        ok++;
        const payload = ("data" in result && result.data) || ("custom" in result && result.custom) || "";
        const flat = JSON.stringify(payload);
        if (ROWS) flatten(payload).forEach((r, i) => rowsOut.push([target.id, target.category, c.label, String(run + 1), String(i + 1), r.title, r.url, r.score, r.text, String(Math.round(ms))]));
        const s = target.latencyOnly ? null : score(c, flat);
        if (s !== null) scores.push(s);
      } else {
        const e = result.error as { code?: string; message?: string } | undefined;
        errors.push(`${e?.code ?? "ERR"}: ${(e?.message ?? "").slice(0, 80)}`);
      }
      if (DELAY) await sleep(DELAY);
    }
  }
  const sorted = [...times].sort((a, b) => a - b);
  const price = PRICING[target.id];
  rows.push({
    id: target.id, category: target.category, calls, ok, firstMs: Math.round(times[0] ?? 0), p50: Math.round(pct(sorted, 50)),
    p95: Math.round(pct(sorted, 95)), max: Math.round(sorted[sorted.length - 1] ?? 0),
    quality: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100 : null,
    estUsd: price?.perCallUsd !== undefined ? Math.round(price.perCallUsd * calls * 10000) / 10000 : null,
    free: price?.free ?? "?", errors: [...new Set(errors)].slice(0, 3),
  });
}

console.log("\nprovider            category           ok/calls  first   p50    p95    quality  est $");
for (const r of rows) {
  console.log(
    `${r.id.padEnd(19)} ${r.category.padEnd(18)} ${`${r.ok}/${r.calls}`.padEnd(9)} ${`${r.firstMs}ms`.padEnd(7)} ${`${r.p50}ms`.padEnd(6)} ${`${r.p95}ms`.padEnd(6)} ${String(r.quality ?? "n/a").padEnd(8)} ${r.estUsd ?? "?"}`,
  );
  for (const e of r.errors) console.log(`    ! ${e}`);
}
mkdirSync("data", { recursive: true });
writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), runs: RUNS, rows }, null, 2));
console.log(`\nWrote ${OUT}. No keys are stored in it.`);
if (ROWS) {
  const header = ["provider", "category", "case", "run", "rank", "title", "url", "score", "text", "latency_ms"];
  writeFileSync(ROWS, [header, ...rowsOut].map((r) => r.map(csvCell).join(",")).join("\n") + "\n");
  console.log(`Wrote ${rowsOut.length} rows to ${ROWS}.`);
}
