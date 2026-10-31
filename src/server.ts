import { createServer } from "node:http";
import { createHandler } from "./api.js";
import { llmConfigured, loadEnv, parseConfig } from "./config.js";
import { createLlmClient } from "./llm.js";

loadEnv();
const config = parseConfig();

const llm =
  llmConfigured(config) && config.llmKey
    ? createLlmClient({
        apiKey: config.llmKey,
        baseUrl: config.llmBaseUrl,
        model: config.llmModel,
        timeoutMs: config.llmTimeoutMs,
      })
    : undefined;

const handler = createHandler({ config, llm });

const server = createServer((req, res) => {
  const started = Date.now();
  res.on("finish", () => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (path.startsWith("/api/")) {
      console.log(`${req.method} ${path} ${res.statusCode} ${Date.now() - started}ms`);
    }
  });

  handler(req, res).catch((err: unknown) => {
    console.error("Unhandled error while serving a request:", err instanceof Error ? err.name : "unknown");
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "error", error: { code: "E_INTERNAL", message: "Internal server error" } }));
  });
});

server.listen(config.port, () => {
  console.log(`gtm-router listening on http://localhost:${config.port}`);
  console.log(
    `config: tavily=${Boolean(config.tavilyKey)} jina=${Boolean(config.jinaKey)} llm=${llmConfigured(config)}` +
      (config.llmModel ? ` model=${config.llmModel}` : ""),
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 3000).unref();
  });
}
