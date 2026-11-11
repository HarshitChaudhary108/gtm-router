import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { buildEngineDepsForKeys, type AppContext } from "./api.js";
import { createConnections } from "./connections.js";
import { KeyResolver } from "./keys.js";
import { ToolCatalog, capabilityLine } from "./tools.js";
import { authenticate, authRequired, type AuthOptions, type TokenStore } from "./auth.js";
import { providerStatus, secretsOf } from "./config.js";
import { executeAction, type EngineDeps } from "./engine.js";
import { AppError, redactSecrets, toAppError } from "./errors.js";
import { route } from "./router.js";
import { createSignup } from "./signup.js";
import { serveSetup } from "./setup.js";
import type { NormalizedResponse } from "./types.js";
import { newRequestId } from "./util.js";

const MAX_BODY_BYTES = 64 * 1024;

const TOOL_DESCRIPTION =
  "GTM company and contact research. Use this FIRST whenever the user asks about a company, " +
  "account, person, role/title, business email, headcount, revenue, industry, location, or asks " +
  "you to research a company or read/extract a webpage. Examples: 'find VPs of Engineering at " +
  "vercel.com', 'how many employees does Stripe have', 'get the email for the CTO at Notion', " +
  "'what does https://vercel.com/pricing say'. It queries B2B data and web providers, reads " +
  "pages, and returns normalized records with source URLs and provider attribution. Prefer it " +
  "over general web search or memory for people, company, contact and email lookups; never " +
  "guess an email address when this tool can check. Pass the user's full question in natural " +
  "language.";

const SERVER_INSTRUCTIONS =
  "This server exposes outmate_search. For any request about companies, accounts, people, titles, " +
  "business emails, firmographics or company web research, call outmate_search with the user's " +
  "full question instead of answering from memory or using a general web search. It handles " +
  "the whole bounded research pipeline in one call.";

function textSummary(result: NormalizedResponse, secrets: string[]): string {
  const lines: string[] = [result.answer ?? "(no answer)"];

  if (result.data.companies.length > 0) {
    lines.push("", "Companies:");
    for (const company of result.data.companies.slice(0, 10)) {
      const meta = [
        company.domain,
        company.industry,
        company.employee_range ?? company.employee_count,
        company.revenue_range,
        [company.city, company.country].filter(Boolean).join(", "),
      ]
        .filter(Boolean)
        .join(" · ");
      lines.push(`- ${company.name ?? company.domain ?? "—"}${meta ? ` — ${meta}` : ""}`);
    }
  }

  if (result.data.people.length > 0) {
    lines.push("", "People:");
    for (const person of result.data.people.slice(0, 10)) {
      const meta = [person.title, person.company_name, person.business_email].filter(Boolean).join(" · ");
      lines.push(`- ${person.name ?? "—"}${meta ? ` — ${meta}` : ""}`);
    }
  }

  if (result.data.page) {
    const page = result.data.page;
    lines.push("", `Page: ${page.url} (${page.content_length} chars${page.truncated ? ", truncated" : ""})`);
  }

  if (result.data.results.length > 0) {
    lines.push("", "Sources:");
    for (const item of result.data.results.slice(0, 10)) lines.push(`- ${item.url}`);
  }

  if (result.execution.length > 0) {
    lines.push(
      "",
      `Execution: ${result.execution
        .map((step) => `${step.action}:${step.status}(${step.provider}, ${step.duration_ms}ms)`)
        .join(" -> ")}`,
    );
  }

  if (result.error) lines.push("", `Error: ${result.error.code} — ${result.error.message}`);

  return redactSecrets(lines.join("\n"), secrets);
}

/** One MCP server instance per HTTP request: stateless, no session state to leak between callers. */
export function createMcpServer(
  ctx: AppContext,
  engineDeps: EngineDeps,
  secrets: string[],
  opts: { catalog?: ToolCatalog; hasKey?: (slot: string) => boolean } = {},
): McpServer {
  const catalog = opts.catalog;
  // The description tells the agent what this user's outmate_search can currently do.
  const description = catalog && opts.hasKey
    ? `${TOOL_DESCRIPTION} ${capabilityLine(catalog.availableFor(opts.hasKey))}`.trim()
    : TOOL_DESCRIPTION;
  const server = new McpServer(
    { name: "outmate", version: "0.1.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    "outmate_search",
    {
      title: "GTM research search",
      description,
      inputSchema: {
        query: z
          .string()
          .trim()
          .min(1)
          .max(ctx.config.maxRequestChars)
          .describe("The user's research question or instruction, in natural language."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query }) => {
      try {
        const result = await route(query, {
          config: ctx.config,
          requestId: newRequestId(),
          llm: ctx.llm,
          tools: catalog,
          hasKey: opts.hasKey,
          execute: (name, input) => executeAction(name, input, engineDeps),
        });
        return {
          content: [{ type: "text" as const, text: textSummary(result, secrets) }],
          structuredContent: result as unknown as Record<string, unknown>,
          isError: result.status === "error",
        };
      } catch (err) {
        const error = toAppError(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `GTM Router error: ${error.code} — ${redactSecrets(error.message, secrets)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  return server;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

export interface McpHandlerOptions {
  allowedHosts?: string[];
  /** Per-user bearer tokens. When this store's file exists, a valid token is required. */
  tokens?: TokenStore;
}

/** HTTP handler for the MCP endpoint and a small health probe. */
export function createMcpHandler(
  ctx: AppContext,
  options: McpHandlerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const secrets = secretsOf(ctx.config);
  const catalog = new ToolCatalog();
  const keys = new KeyResolver(ctx.config, ctx.fetchImpl);
  const signup = createSignup({ config: ctx.config, tokens: options.tokens });
  const authOptions: AuthOptions = { legacyToken: ctx.config.mcpAuthToken, store: options.tokens };
  const connections = createConnections({ config: ctx.config, auth: authOptions, keys, catalog });
  const allowedHosts = options.allowedHosts ?? [
    `localhost:${ctx.config.mcpPort}`,
    `127.0.0.1:${ctx.config.mcpPort}`,
  ];

  return async (req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";

    try {
      if (path === "/health") {
        if (req.method !== "GET") {
          res.setHeader("Allow", "GET");
          sendJson(res, 405, { status: "error", error: "Use GET" });
          return;
        }
        sendJson(res, 200, {
          status: "ok",
          service: "outmate-mcp",
          endpoint: "/mcp",
          config: providerStatus(ctx.config),
          auth: authRequired(authOptions),
        });
        return;
      }

      if (await signup(req, res, path)) return;
      if (await connections(req, res, path)) return;
      if (await serveSetup(req, res, path, { config: ctx.config, tokens: options.tokens })) return;

      if (path !== "/mcp") throw new AppError("E_NOT_FOUND", "Not found");

      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        sendJson(res, 405, { status: "error", error: "Only POST is supported in stateless mode" });
        return;
      }

      const identity = authenticate(req, authOptions);
      if (!identity) {
        sendJson(res, 401, { status: "error", error: "Unauthorized" });
        return;
      }

      // This user's keys (their own from Nango, else the server's) decide which tools they get.
      const resolved = await keys.forUser(identity.name, catalog.keySlots());
      const engineDeps = buildEngineDepsForKeys(ctx, resolved.keys, catalog);
      const userSecrets = [...secrets, ...Object.values(resolved.keys)];
      const server = createMcpServer(ctx, engineDeps, userSecrets, {
        catalog,
        hasKey: (slot) => Boolean(resolved.keys[slot]),
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        enableDnsRebindingProtection: true,
        allowedHosts,
        maxRequestBodySize: MAX_BODY_BYTES,
      });

      res.on("close", () => {
        transport.close().catch(() => undefined);
        server.close().catch(() => undefined);
      });

      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      const error = toAppError(err);
      console.error(`mcp request failed: ${error.code} (${err instanceof Error ? err.name : "unknown"})`);
      sendJson(res, error.status, {
        jsonrpc: "2.0",
        error: { code: -32603, message: redactSecrets(error.message, secrets) },
        id: null,
      });
    }
  };
}
