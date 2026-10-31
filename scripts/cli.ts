/**
 * Interactive CLI for the GTM router. Shows example queries, then routes
 * either a numbered example or a query typed by the user.
 * Run: npm run cli  (or npm run cli -- "your query")
 */
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { llmConfigured, loadEnv, parseConfig } from "../src/config.js";
import { executeAction } from "../src/engine.js";
import { toAppError } from "../src/errors.js";
import { createLlmClient } from "../src/llm.js";
import { route } from "../src/router.js";
import type { CompanyResult, NormalizedResponse, PeopleResult } from "../src/types.js";

const EXAMPLES = [
  { query: "Research Vercel, find its official pricing page, and extract the page content.", note: "search + read" },
  { query: "Find 5 fintech companies in the United States with 51-200 employees.", note: "MoltSets company search" },
  { query: "Find engineering leaders at vercel.com.", note: "MoltSets people search" },
  { query: "Find the latest posts on the Anthropic engineering blog.", note: "search only" },
  { query: "Read https://example.com and summarize it.", note: "read a URL from your message" },
  { query: "Find verified marketing emails at thoughtspot.com.", note: "Hunter email discovery" },
  { query: "Look up Acme's pricing page.", note: "ambiguous — asks which Acme" },
] as const;

loadEnv();
const config = parseConfig();

if (!llmConfigured(config) || !config.llmKey) {
  console.error("LLM_API_KEY and LLM_MODEL are required for routing. Fill them in .env.");
  process.exit(1);
}

const llm = createLlmClient({
  apiKey: config.llmKey,
  baseUrl: config.llmBaseUrl,
  model: config.llmModel,
  timeoutMs: config.llmTimeoutMs,
});

function printCompanies(companies: CompanyResult[]): void {
  if (companies.length === 0) return;
  console.log("companies:");
  for (const company of companies) {
    const meta = [
      company.domain,
      company.industry,
      company.employee_range ?? company.employee_count,
      company.revenue_range,
      [company.city, company.country].filter(Boolean).join(", "),
    ]
      .filter(Boolean)
      .join(" · ");
    console.log(`  - ${company.name ?? company.domain ?? "—"}${meta ? ` — ${meta}` : ""}`);
  }
}

function printPeople(people: PeopleResult[]): void {
  if (people.length === 0) return;
  console.log("people:");
  for (const person of people) {
    const meta = [person.title, person.company_name, person.business_email, person.business_email_status]
      .filter(Boolean)
      .join(" · ");
    console.log(`  - ${person.name ?? "—"}${meta ? ` — ${meta}` : ""}`);
  }
}

function printResult(result: NormalizedResponse): void {
  console.log(
    `\nstatus: ${result.status}  (${result.meta.duration_ms} ms, ${result.meta.tools_used} tool call(s))`,
  );
  if (result.error) console.log(`error: ${result.error.code} — ${result.error.message}`);

  if (result.status === "needs_input") {
    console.log(`question: ${result.answer}`);
    result.data.results.forEach((item, index) => {
      console.log(`  ${index + 1}. ${item.title ?? item.url}`);
      console.log(`     ${item.url}`);
    });
    return;
  }

  if (result.answer) console.log(`\n${result.answer}\n`);

  if (result.data.page) {
    const page = result.data.page;
    console.log(`page: ${page.url} (${page.content_length} chars${page.truncated ? ", truncated" : ""})`);
  }
  printCompanies(result.data.companies);
  printPeople(result.data.people);
  if (result.data.results.length > 0) {
    console.log("sources:");
    result.data.results.slice(0, 5).forEach((item) => console.log(`  - ${item.url}`));
  }
  if (result.execution.length > 0) {
    console.log(
      `trace: ${result.execution.map((step) => `${step.action}:${step.status}(${step.provider}, ${step.duration_ms}ms)`).join(" -> ")}`,
    );
  }
}

async function runOnce(query: string): Promise<void> {
  try {
    const result = await route(query, {
      config,
      requestId: "req_cli",
      llm,
      execute: (name, actionInput) =>
        executeAction(name, actionInput, {
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
        }),
    });
    printResult(result);
  } catch (err) {
    const error = toAppError(err);
    console.log(`\nerror: ${error.code} — ${error.message}`);
  }
}

function exampleFor(value: string): string | undefined {
  const index = Number(value) - 1;
  return /^[1-9]$/.test(value) ? EXAMPLES[index]?.query : undefined;
}

function printExamples(): void {
  console.log("GTM Router CLI — natural-language search (Tavily) and page reads (Jina) via tool calling.\n");
  console.log("Examples:");
  EXAMPLES.forEach((example, index) => {
    console.log(`  ${index + 1}. ${example.query}`);
    console.log(`     (${example.note})`);
  });
}

const arg = process.argv.slice(2).join(" ").trim();

if (arg) {
  const query = exampleFor(arg) ?? arg;
  if (query !== arg) console.log(`→ ${query}`);
  await runOnce(query);
} else {
  printExamples();
  const rl = createInterface({ input, output });
  try {
    for (;;) {
      const answer = (await rl.question(
        `\nEnter 1-${EXAMPLES.length} for an example, or type your own query (empty to quit): `,
      )).trim();
      if (!answer) break;
      const query = exampleFor(answer) ?? answer;
      if (query !== answer) console.log(`→ ${query}`);
      await runOnce(query);
    }
  } catch {
    // stdin closed (EOF or Ctrl+C)
  } finally {
    rl.close();
  }
}
