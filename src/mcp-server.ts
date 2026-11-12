import { createServer } from "node:http";
import { TokenStore } from "./auth.js";
import { llmConfigured, loadEnv, parseConfig } from "./config.js";
import { createLlmClient } from "./llm.js";
import { createMcpHandler } from "./mcp.js";

loadEnv();
const config = parseConfig();

const llm =
  llmConfigured(config) && config.llmKey
    ? createLlmClient({
        apiKey: config.llmKey,
        baseUrl: config.llmBaseUrl,
        model: config.llmModel,
        reasoningEffort: config.llmReasoningEffort,
        timeoutMs: config.llmTimeoutMs,
      })
    : undefined;

const tokens = new TokenStore(config.tokensFile);
const handler = createMcpHandler({ config, llm }, { tokens });

const server = createServer((req, res) => {
  const started = Date.now();
  res.on("finish", () => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (path === "/mcp" || path === "/health") {
      console.log(`${req.method} ${path} ${res.statusCode} ${Date.now() - started}ms`);
    }
  });

  handler(req, res).catch((err: unknown) => {
    console.error("Unhandled error while serving an MCP request:", err instanceof Error ? err.name : "unknown");
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
  });
});

server.listen(config.mcpPort, config.mcpHost, () => {
  console.log(`outmate MCP listening on http://${config.mcpHost}:${config.mcpPort}/mcp`);
  console.log(
    `config: tavily=${Boolean(config.tavilyKey)} jina=${Boolean(config.jinaKey)} moltsets=${Boolean(config.moltsetsKey)}` +
      ` llm=${llmConfigured(config)} auth=${Boolean(config.mcpAuthToken) || tokens.exists()} public_url=${config.publicUrl ?? "from request"}`,
  );
  console.log("router embedded; REST server optional (npm start)");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 3000).unref();
  });
}
