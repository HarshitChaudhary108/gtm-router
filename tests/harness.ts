import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenStore } from "../src/auth.js";
import { parseConfig, type Config } from "../src/config.js";
import type { LlmClient, LlmMessage, LlmResponse } from "../src/llm.js";
import { createMcpHandler } from "../src/mcp.js";

export interface TestServer {
  base: string;
  store: TokenStore;
  dir: string;
  close(): Promise<void>;
}

/** Real HTTP server around the real MCP handler. Providers and the LLM are faked. */
export async function startServer(
  options: { llm?: LlmClient; fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>; config?: Partial<Config> } = {},
): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), "outmate-test-"));
  const store = new TokenStore(join(dir, "tokens.json"));
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  const config: Config = {
    ...parseConfig({}),
    mcpPort: port,
    publicUrl: base,
    tavilyKey: "tvly_secret_key_123456",
    ...options.config,
  };
  const handler = createMcpHandler(
    {
      config,
      llm: options.llm,
      fetchImpl: options.fetchImpl as never,
      lookup: async () => [{ address: "93.184.216.34" }],
      retryDelayMs: 0,
    },
    { allowedHosts: [`127.0.0.1:${port}`], tokens: store },
  );
  server.on("request", (req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  return { base, store, dir, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

export function fakeLlm(respond: (messages: LlmMessage[]) => LlmResponse): LlmClient {
  return { complete: async (messages) => respond(messages) };
}

/** First turn: ask for one web search. After the tool result: give a final answer. */
export const searchThenAnswer = (answer: string): LlmClient =>
  fakeLlm((messages) =>
    messages.some((m) => m.role === "tool")
      ? { content: answer, toolCalls: [], finishReason: "stop" }
      : {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "call_1", name: "web_search", arguments: JSON.stringify({ query: "acme pricing", max_results: 2 }) }],
        },
  );

export const fakeTavily = async (): Promise<Response> =>
  new Response(
    JSON.stringify({ query: "acme pricing", results: [{ title: "Acme Pricing", url: "https://acme.com/pricing", content: "Plans from $10", score: 0.9 }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
