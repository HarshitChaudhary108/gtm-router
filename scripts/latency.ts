/**
 * End-to-end latency of one question through the real MCP server, split into where the time goes:
 *
 *   total (what the agent waits for)
 *     = MCP session setup (once)           connect + tool list
 *     + server work: token check, key lookup, rendering, HTTP
 *     + router: each LLM turn that plans the research
 *     + tools: each provider call
 *
 *   npx tsx scripts/latency.ts "find me engineering leads in vercel, 10 only" --runs 3 --gap 40
 *
 * Needs LLM_* and at least one provider key in .env. Results go to data/latency-<time>.json.
 * It measures outmate only: the agent's own thinking time before and after calling the tool is not
 * included, because it depends on which agent and model the user has. With --agent <model> it also
 * runs one real headless Claude Code call against this server, so the agent's share is visible too.
 */
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { llmConfigured, loadEnv, parseConfig } from "../src/config.js";
import { createLlmClient, type LlmClient } from "../src/llm.js";
import { startServer } from "../tests/harness.js";

loadEnv();

const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const query = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--"))) ?? "find me engineering leads in vercel, 10 only";
const RUNS = Math.max(0, Number(opt("runs", "3")));
const GAP = Math.max(0, Number(opt("gap", "40")));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const config = parseConfig();
if (!llmConfigured(config) || !config.llmKey) {
  console.log("No router LLM configured (LLM_API_KEY, LLM_MODEL in .env), so nothing was run.");
  process.exit(0);
}

interface Turn {
  n: number;
  ms: number;
  asked: string[];
  promptChars: number;
}
let turns: Turn[] = [];
const base: LlmClient = createLlmClient({
  apiKey: config.llmKey,
  baseUrl: config.llmBaseUrl,
  model: config.llmModel,
  reasoningEffort: config.llmReasoningEffort,
  timeoutMs: config.llmTimeoutMs,
});
const timed: LlmClient = {
  complete: async (messages, tools) => {
    const started = performance.now();
    try {
      const res = await base.complete(messages, tools);
      turns.push({ n: turns.length + 1, ms: Math.round(performance.now() - started), asked: res.toolCalls.map((c) => c.name), promptChars: JSON.stringify(messages).length + JSON.stringify(tools ?? []).length });
      return res;
    } catch (err) {
      turns.push({ n: turns.length + 1, ms: Math.round(performance.now() - started), asked: ["(failed)"], promptChars: 0 });
      throw err;
    }
  },
};

const fetches: Array<{ host: string; ms: number }> = [];
const timedFetch = async (url: string, init?: RequestInit): Promise<Response> => {
  const started = performance.now();
  try {
    return await fetch(url, init);
  } finally {
    fetches.push({ host: new URL(url).host, ms: Math.round(performance.now() - started) });
  }
};
const srv = await startServer({ llm: timed, config, fetchImpl: timedFetch });
const token = srv.store.create("latency-check").token;

const setupStarted = performance.now();
const client = new Client({ name: "latency", version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
await client.listTools();
const setupMs = Math.round(performance.now() - setupStarted);

interface Run {
  run: number;
  ok: boolean;
  totalMs: number;
  routerMs: number;
  toolsMs: number;
  routeInternalMs: number;
  serverMs: number;
  turns: Turn[];
  tools: Array<{ action: string; provider: string; status: string; ms: number }>;
  answer: string;
  text: string;
  /** Every hit the search returned, so the data can be read, not just the timings. */
  results: Array<{ title: string; url: string; score: number | null; text: string }>;
  error?: string;
}
const runs: Run[] = [];
console.log(`Question: ${query}\nRouter: ${config.llmModel} · runs: ${RUNS} · gap: ${GAP}s\nMCP session setup (connect + tool list): ${setupMs} ms\n`);

for (let i = 1; i <= RUNS; i++) {
  turns = [];
  const started = performance.now();
  const res = await client.callTool({ name: "outmate_search", arguments: { query } });
  const totalMs = Math.round(performance.now() - started);
  const structured = (res.structuredContent ?? {}) as { execution?: Array<{ action: string; provider: string; status: string; duration_ms: number }>; meta?: { duration_ms?: number }; answer?: string | null; error?: { message?: string }; data?: { results?: Array<{ title: string | null; url: string; score: number | null; content: string | null; snippet: string | null }> } };
  const text = ((res.content as Array<{ text: string }>)[0]?.text) ?? "";
  const tools = (structured.execution ?? []).map((s) => ({ action: s.action, provider: s.provider, status: s.status, ms: s.duration_ms }));
  const routerMs = turns.reduce((a, t) => a + t.ms, 0);
  const toolsMs = tools.reduce((a, t) => a + t.ms, 0);
  const routeInternalMs = structured.meta?.duration_ms ?? 0;
  const run: Run = {
    run: i, ok: !res.isError, totalMs, routerMs, toolsMs, routeInternalMs,
    serverMs: Math.max(0, totalMs - routeInternalMs), turns: [...turns], tools,
    answer: structured.answer ?? "", text,
    results: (structured.data?.results ?? []).map((r) => ({ title: r.title ?? "", url: r.url, score: r.score, text: (r.content ?? r.snippet ?? "").replace(/\s+/g, " ").slice(0, 600) })),
    error: res.isError ? text.slice(0, 160) : undefined,
  };
  runs.push(run);
  console.log(`run ${i}: ${run.ok ? "ok" : "FAILED"}  total ${totalMs} ms = router ${routerMs} (${turns.length} turns) + tools ${toolsMs} (${tools.length} calls) + other ${totalMs - routerMs - toolsMs}`);
  turns.forEach((t) => console.log(`   router turn ${t.n}: ${t.ms} ms → ${t.asked.join(", ") || "final answer"}`));
  tools.forEach((t) => console.log(`   tool ${t.action} (${t.provider}): ${t.ms} ms ${t.status}`));
  if (run.error) console.log(`   ! ${run.error}`);
  if (i < RUNS && GAP) await sleep(GAP * 1000);
}

await client.close();

// ---- optional: one run through a real agent --------------------------------------------------------
let agent: Record<string, unknown> | null = null;
const agentModel = opt("agent", "");
if (agentModel) {
  turns = [];
  fetches.length = 0;
  const mcp = JSON.stringify({ mcpServers: { outmate: { type: "http", url: `${srv.base}/mcp`, headers: { Authorization: `Bearer ${token}` } } } });
  const started = performance.now();
  const out = await new Promise<string>((resolve) => {
    execFile(
      "claude",
      ["-p", query, "--model", agentModel, "--mcp-config", mcp, "--strict-mcp-config", "--allowedTools", "mcp__outmate__outmate_search", "--output-format", "json"],
      { timeout: 240_000, maxBuffer: 20_000_000 },
      (err, stdout) => resolve(err && !stdout ? `ERROR ${err.message.slice(0, 200)}` : stdout),
    );
  });
  const wallMs = Math.round(performance.now() - started);
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(out) as Record<string, unknown>;
  } catch {
    parsed = { error: out.slice(0, 200) };
  }
  const routerMs = turns.reduce((a, t) => a + t.ms, 0);
  const toolsMs = fetches.reduce((a, f) => a + f.ms, 0);
  agent = {
    model: agentModel, wallMs, routerMs, routerTurns: turns.length, toolsMs, toolCalls: fetches.length,
    agentOnlyMs: Math.max(0, wallMs - routerMs - toolsMs), claudeDurationMs: parsed.duration_ms, claudeApiMs: parsed.duration_api_ms,
    numTurns: parsed.num_turns, costUsd: parsed.total_cost_usd, answer: typeof parsed.result === "string" ? parsed.result : "", error: parsed.error ?? (parsed.is_error ? "agent reported an error" : undefined),
  };
  console.log(`\nagent run (${agentModel}): wall ${wallMs} ms = outmate router ${routerMs} + tools ${toolsMs} + agent and startup ${wallMs - routerMs - toolsMs}   (agent turns: ${parsed.num_turns ?? "?"})`);
  if (agent.error) console.log(`   ! ${String(agent.error)}`);
}
await srv.close();
mkdirSync("data", { recursive: true });
const out = `data/latency-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), query, router: config.llmModel, setupMs, runs, agent }, null, 2));
console.log(`\nWrote ${out}`);
process.exit(0);
