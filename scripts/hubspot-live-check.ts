/**
 * Live check of the HubSpot read tools and the propose-then-approve write-back, against a real
 * HubSpot account. Meant for a free HubSpot developer test account, NOT a real CRM.
 *
 *   npx tsx scripts/hubspot-live-check.ts             shows what it would do, changes nothing
 *   npx tsx scripts/hubspot-live-check.ts --yes-write runs it
 *   npx tsx scripts/hubspot-live-check.ts --yes-write --keep    leave the test contact in place
 *
 * Needs HUBSPOT_WRITE_API_KEY (or HUBSPOT_API_KEY) in .env: the token of a HubSpot private app with
 * contacts read and write and companies read. It creates ONE contact with a unique address
 * (outmate-check-<id>@example.com), fills a blank field on it, checks that an existing value is
 * never overwritten, then archives it. It prints each step with its timing and never prints the token.
 */
import { pathToFileURL } from "node:url";
import { loadEnv } from "../src/config.js";
import type { FetchLike } from "../src/http.js";
import { ProposalStore, type Proposal } from "../src/proposals.js";
import { ToolCatalog, runHttpTool } from "../src/tools.js";
import { applyApproved, runInternalTool, type WritebackDeps } from "../src/writeback.js";

export interface Step {
  name: string;
  ok: boolean;
  ms: number;
  detail: string;
}

export interface CheckOptions {
  token: string;
  fetchImpl?: FetchLike;
  /** Archive the test contact at the end. Default true. */
  cleanup?: boolean;
  log?: (line: string) => void;
}

const API = "https://api.hubapi.com";

export async function runHubspotCheck(opts: CheckOptions): Promise<{ ok: boolean; steps: Step[] }> {
  const fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const log = opts.log ?? (() => undefined);
  const steps: Step[] = [];
  const catalog = new ToolCatalog();
  const store = new ProposalStore();
  const proposals: Proposal[] = [];
  const deps: WritebackDeps = {
    apiKey: opts.token, user: "live-check", store, fetchImpl, timeoutMs: 20_000, retryDelayMs: 300,
    onProposal: (p) => proposals.push(p),
  };
  const raw = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetchImpl(`${API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${opts.token}`, "Content-Type": "application/json", Accept: "application/json" },
    });
  const findByEmail = async (email: string): Promise<{ id: string; properties: Record<string, string> } | null> => {
    const res = await raw("/crm/v3/objects/contacts/search", {
      method: "POST",
      body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }], properties: ["firstname", "lastname", "jobtitle", "company", "email"], limit: 1 }),
    });
    if (!res.ok) throw new Error(`search returned HTTP ${res.status}`);
    const body = (await res.json()) as { results?: Array<{ id: string; properties: Record<string, string> }> };
    return body.results?.[0] ?? null;
  };

  const step = async (name: string, fn: () => Promise<string>): Promise<boolean> => {
    const started = performance.now();
    let result: Step;
    try {
      const detail = await fn();
      result = { name, ok: true, ms: Math.round(performance.now() - started), detail };
    } catch (err) {
      result = { name, ok: false, ms: Math.round(performance.now() - started), detail: err instanceof Error ? err.message : String(err) };
    }
    steps.push(result);
    log(`${result.ok ? "PASS" : "FAIL"}  ${name.padEnd(46)} ${String(result.ms).padStart(5)} ms  ${result.detail}`);
    return result.ok;
  };

  const id = Math.random().toString(16).slice(2, 8);
  const email = `outmate-check-${id}@example.com`;
  const person = { firstname: "Check", lastname: `Run${id}`, email, company: "Outmate Check" };
  let recordId = "";
  const toolDeps = { apiKey: opts.token, fetchImpl, timeoutMs: 20_000, maxChars: 4000 };
  const propose = async (contact: Record<string, string>): Promise<Proposal> => {
    await runInternalTool("hubspot_propose_contacts", { contacts: [contact], source_note: "outmate live check" }, deps);
    return proposals[proposals.length - 1]!;
  };

  await step("read: search companies", async () => {
    const out = await runHttpTool(catalog.byTool("hubspot_search_companies")!, { query: "outmate", limit: 1 }, toolDeps);
    return `${Array.isArray(out) ? out.length : 0} found`;
  });
  await step("read: search contacts", async () => {
    const out = await runHttpTool(catalog.byTool("hubspot_search_contacts")!, { query: "outmate", limit: 1 }, toolDeps);
    return `${Array.isArray(out) ? out.length : 0} found`;
  });

  let created = false;
  await step("propose a new contact, nothing written", async () => {
    const p = await propose(person);
    if (p.changes[0]?.kind !== "create") throw new Error(`expected create, got ${p.changes[0]?.kind}`);
    if (await findByEmail(email)) throw new Error("the contact exists before approval: the proposal wrote something");
    return `proposal ${p.id}`;
  });
  created = await step("approve: contact is created, with a note", async () => {
    const res = await applyApproved(proposals[proposals.length - 1]!.id, deps);
    if (!/1 created/.test(res.text)) throw new Error(res.text.split("\n").slice(0, 3).join(" | "));
    const found = await findByEmail(email);
    if (!found) throw new Error("approved, but the contact cannot be found");
    recordId = found.id;
    return /note could not be added/.test(res.text) ? "created; the note was refused (check notes access)" : "created with a note";
  });

  if (created) {
    await step("propose + approve: fills a blank job title", async () => {
      const p = await propose({ ...person, jobtitle: "Head of Checks" });
      if (p.changes[0]?.kind !== "fill") throw new Error(`expected fill, got ${p.changes[0]?.kind}`);
      const res = await applyApproved(p.id, deps);
      if (!/1 filled/.test(res.text)) throw new Error(res.text.split("\n").slice(0, 3).join(" | "));
      const found = await findByEmail(email);
      if (found?.properties.jobtitle !== "Head of Checks") throw new Error(`job title is "${found?.properties.jobtitle}"`);
      if (found.properties.firstname !== "Check") throw new Error("another field changed");
      return "filled, other fields untouched";
    });
    await step("a different title is never overwritten", async () => {
      const p = await propose({ ...person, jobtitle: "Some Other Title" });
      if (p.changes[0]?.kind !== "skip") throw new Error(`expected skip, got ${p.changes[0]?.kind}`);
      await applyApproved(p.id, deps);
      const found = await findByEmail(email);
      if (found?.properties.jobtitle !== "Head of Checks") throw new Error(`job title became "${found?.properties.jobtitle}"`);
      return "kept the existing title";
    });
  }

  if (recordId && opts.cleanup !== false) {
    await step("cleanup: archive the test contact", async () => {
      const res = await raw(`/crm/v3/objects/contacts/${encodeURIComponent(recordId)}`, { method: "DELETE" });
      if (res.status !== 204 && !res.ok) throw new Error(`HTTP ${res.status}`);
      return "archived";
    });
  } else if (recordId) {
    log(`kept: contact ${email} (id ${recordId})`);
  }

  return { ok: steps.every((s) => s.ok), steps };
}

async function main(): Promise<void> {
  loadEnv();
  const token = process.env.HUBSPOT_WRITE_API_KEY?.trim() || process.env.HUBSPOT_API_KEY?.trim();
  if (!token) {
    console.log("No HUBSPOT_WRITE_API_KEY (or HUBSPOT_API_KEY) in .env, so nothing was called.");
    console.log("Create a free HubSpot developer test account, make a private app with contacts read+write and companies read, and put its token in .env.");
    return;
  }
  if (!process.argv.includes("--yes-write")) {
    console.log("Dry run. With --yes-write this would, in the HubSpot account of that token:");
    console.log("  1. search companies and contacts (read)");
    console.log("  2. propose a new contact outmate-check-<id>@example.com and confirm nothing was written");
    console.log("  3. approve it, so the contact is created with a note");
    console.log("  4. fill a blank job title, and confirm a different title is never overwritten");
    console.log("  5. archive the test contact (skip with --keep)");
    console.log("Use a developer test account, not your real CRM.");
    return;
  }
  const report = await runHubspotCheck({ token, cleanup: !process.argv.includes("--keep"), log: (l) => console.log(l) });
  const total = report.steps.reduce((a, s) => a + s.ms, 0);
  console.log(`\n${report.steps.filter((s) => s.ok).length}/${report.steps.length} steps passed · ${total} ms in total`);
  if (!report.ok) {
    console.log("If a step says HubSpot refused it: open the private app, Auth tab, and add the scope named in the message.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
