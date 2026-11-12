/**
 * Sends every http tool's real request with a FAKE key and reports what the provider answered.
 * 401/403 = reached the provider and the key was refused (host, path and auth placement are right).
 * It does not prove the request body or query shape; only a real key can.
 *
 *   npx tsx scripts/probe-tools.ts            # all tools
 *   npx tsx scripts/probe-tools.ts exa hunter # only these providers / tool names
 */
import { ToolCatalog, resolveBase, runHttpTool, describeHttpRequest, type ToolFile } from "../src/tools.js";

// Two halves, so tools that need "first:second" get both.
const FAKE_KEY = "fake_key_for_probe_0000:fake_secret_for_probe_0000";
const META = { instance_url: process.env.PROBE_INSTANCE_URL ?? "https://login.salesforce.com" };
const SAMPLE: Record<string, string> = {
  query: "stripe", url: "https://stripe.com", domain: "stripe.com", email: "jane.doe@stripe.com", name: "Jane Doe",
  first_name: "Jane", last_name: "Doe", company: "palantir", current_employer: "Stripe", linkedin_url: "https://www.linkedin.com/in/janedoe",
  linkedin_id: "janedoe", profile: "https://www.linkedin.com/in/janedoe", cik: "0001318605", board: "vercel", company_number: "00445790",
  permalink: "stripe", cin: "U72200KA2009PTC050000", job_title: "sales development", term: "stripe", question: "What does this company sell?",
  forms: "10-K", number: "14155552671", uuid: "123e4567-e89b-12d3-a456-426614174000",
};

function sampleInput(tool: ToolFile): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const [k, schema] of Object.entries(tool.parameters.properties as Record<string, { type?: string }>)) {
    if (!tool.parameters.required.includes(k)) continue;
    input[k] = schema.type === "integer" ? 3 : (SAMPLE[k] ?? "test");
  }
  return input;
}

const filters = process.argv.slice(2);
const catalog = new ToolCatalog();
const tools = catalog.list().filter((t) => t.kind === "http" && (!filters.length || filters.some((f) => t.key === f || t.tool === f)));

let statusSeen = 0;
const spy: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  statusSeen = res.status;
  return res;
};

const rows: string[][] = [];
for (const tool of tools) {
  statusSeen = 0;
  const req = describeHttpRequest(tool, sampleInput(tool), tool.request?.base_from ? resolveBase(tool, META) : undefined);
  const host = new URL(req.url).host;
  let verdict: string;
  try {
    await runHttpTool(tool, sampleInput(tool), { apiKey: tool.key ? FAKE_KEY : undefined, meta: META, fetchImpl: spy, timeoutMs: 20_000, retryDelayMs: 0, maxChars: 4000 });
    verdict = tool.key ? "OK (accepted a fake key?)" : "OK (public API answered)";
  } catch (err) {
    const code = (err as { code?: string }).code ?? "ERR";
    const msg = err instanceof Error ? err.message : String(err);
    if (statusSeen === 401 || statusSeen === 403) verdict = "REACHED, key refused";
    else if (statusSeen === 404) verdict = "CHECK: 404 (path wrong?)";
    else if (statusSeen === 400 || statusSeen === 422 || statusSeen === 402 || statusSeen === 429) verdict = `REACHED (HTTP ${statusSeen})`;
    else if (statusSeen === 0) verdict = `NOT REACHED: ${msg.slice(0, 60)}`;
    else verdict = `HTTP ${statusSeen} (${code})`;
  }
  rows.push([tool.tool.padEnd(26), host.padEnd(38), String(statusSeen || "-").padEnd(4), verdict]);
}
for (const r of rows) console.log(r.join(" "));
const reached = rows.filter((r) => r[3]!.startsWith("REACHED") || r[3]!.startsWith("OK")).length;
console.log(`\n${reached}/${rows.length} reached the provider`);
