import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseConfig, type Config } from "../src/config.js";
import { AppError } from "../src/errors.js";
import type { LlmClient, LlmMessage, LlmResponse } from "../src/llm.js";
import { createMcpHandler } from "../src/mcp.js";

const baseConfig = parseConfig({});

function fakeLlm(respond: (messages: LlmMessage[]) => LlmResponse): LlmClient & { calls: LlmMessage[][] } {
  const calls: LlmMessage[][] = [];
  return {
    calls,
    async complete(messages) {
      calls.push(structuredClone(messages));
      return respond(messages);
    },
  };
}

function searchCall(id = "call_1"): LlmResponse {
  return {
    content: "",
    finishReason: "tool_calls",
    toolCalls: [{ id, name: "web_search", arguments: JSON.stringify({ query: "acme pricing", max_results: 2 }) }],
  };
}

function finalAnswer(text: string): LlmResponse {
  return { content: text, toolCalls: [], finishReason: "stop" };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface Harness {
  url: URL;
  server: Server;
  close(): Promise<void>;
}

async function startHarness(options: {
  llm?: LlmClient;
  config?: Partial<Config>;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  authToken?: string;
}): Promise<Harness> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  const config: Config = {
    ...baseConfig,
    mcpPort: port,
    mcpAuthToken: options.authToken,
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
    { allowedHosts: [`127.0.0.1:${port}`] },
  );

  server.on("request", (req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  return {
    url: new URL(`http://127.0.0.1:${port}/mcp`),
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function connect(harness: Harness, headers?: Record<string, string>): Promise<Client> {
  const client = new Client({ name: "mcp-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(harness.url, {
    requestInit: headers ? { headers } : undefined,
  });
  await client.connect(transport);
  return client;
}

test("gtm_search is discoverable with a query input schema", async () => {
  const harness = await startHarness({ llm: fakeLlm(() => finalAnswer("unused")) });
  try {
    const client = await connect(harness);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.name, "gtm_search");
    assert.match(tools[0]?.description ?? "", /business email|company/i);
    assert.deepEqual((tools[0]?.inputSchema as { required?: string[] }).required, ["query"]);
    await client.close();
  } finally {
    await harness.close();
  }
});

test("forwards the query into the router and returns sources + structured content", async () => {
  const llm = fakeLlm((messages) =>
    messages.some((message) => message.role === "tool") ? finalAnswer("Acme offers plans from $10.") : searchCall(),
  );
  const fetchImpl = async () =>
    jsonResponse({
      query: "acme pricing",
      results: [{ title: "Acme Pricing", url: "https://acme.com/pricing", content: "Plans from $10", score: 0.9 }],
    });

  const harness = await startHarness({ llm, fetchImpl });
  try {
    const client = await connect(harness);
    const result = (await client.callTool({
      name: "gtm_search",
      arguments: { query: "What does Acme charge?" },
    })) as {
      content: Array<{ type: string; text: string }>;
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    };

    assert.equal(result.isError, false);
    assert.match(result.content[0]?.text ?? "", /Acme offers plans from \$10/);
    assert.match(result.content[0]?.text ?? "", /https:\/\/acme\.com\/pricing/);
    assert.match(result.content[0]?.text ?? "", /web\.search:success\(tavily/);

    assert.ok(result.structuredContent);
    assert.equal(result.structuredContent.status, "success");
    assert.equal((result.structuredContent.data as { results: unknown[] }).results.length, 1);
    assert.equal((result.structuredContent.execution as unknown[]).length, 1);

    const userMessage = llm.calls[0]?.find((message) => message.role === "user");
    assert.equal(userMessage?.content, "What does Acme charge?");
    await client.close();
  } finally {
    await harness.close();
  }
});

test("provider failure is reported as an error without leaking the API key", async () => {
  const llm = fakeLlm((messages) =>
    messages.some((message) => message.role === "tool") ? finalAnswer("Search failed.") : searchCall(),
  );
  const fetchImpl = async () => jsonResponse({ detail: "bad key tvly_secret_key_123456" }, 401);

  const harness = await startHarness({ llm, fetchImpl });
  try {
    const client = await connect(harness);
    const result = (await client.callTool({ name: "gtm_search", arguments: { query: "acme" } })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /E_PROVIDER_AUTH/);
    assert.doesNotMatch(result.content[0]?.text ?? "", /tvly_secret_key_123456/);
    await client.close();
  } finally {
    await harness.close();
  }
});

test("router timeout surfaces as an error result", async () => {
  const llm: LlmClient = {
    async complete() {
      throw new AppError("E_TIMEOUT", "Upstream request timed out", { retryable: true });
    },
  };
  const harness = await startHarness({ llm });
  try {
    const client = await connect(harness);
    const result = (await client.callTool({ name: "gtm_search", arguments: { query: "acme" } })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /E_TIMEOUT/);
    await client.close();
  } finally {
    await harness.close();
  }
});

test("empty search results still produce a normal answer", async () => {
  const llm = fakeLlm((messages) =>
    messages.some((message) => message.role === "tool") ? finalAnswer("No relevant results.") : searchCall(),
  );
  const fetchImpl = async () => jsonResponse({ query: "acme pricing", results: [] });

  const harness = await startHarness({ llm, fetchImpl });
  try {
    const client = await connect(harness);
    const result = (await client.callTool({ name: "gtm_search", arguments: { query: "acme" } })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    assert.equal(result.isError, false);
    assert.match(result.content[0]?.text ?? "", /No relevant results/);
    await client.close();
  } finally {
    await harness.close();
  }
});

test("rejects an empty query before touching the router", async () => {
  const llm = fakeLlm(() => finalAnswer("unused"));
  const harness = await startHarness({ llm });
  try {
    const client = await connect(harness);
    const result = (await client.callTool({ name: "gtm_search", arguments: { query: "   " } })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /Input validation error/);
    assert.equal(llm.calls.length, 0);
    await client.close();
  } finally {
    await harness.close();
  }
});

test("health endpoint reports provider presence as booleans", async () => {
  const harness = await startHarness({ llm: fakeLlm(() => finalAnswer("unused")) });
  try {
    const res = await fetch(`http://127.0.0.1:${harness.url.port}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { service: string; config: Record<string, unknown>; auth: boolean };
    assert.equal(body.service, "gtm-router-mcp");
    assert.equal(body.config.tavily, true);
    assert.equal(body.config.jina, false);
    assert.equal(body.auth, false);
    assert.equal(typeof body.config.llm, "boolean");
  } finally {
    await harness.close();
  }
});

test("bearer auth rejects missing or wrong tokens and accepts the configured one", async () => {
  const harness = await startHarness({
    llm: fakeLlm(() => finalAnswer("ok")),
    authToken: "test-token-abcdef",
  });
  try {
    const unauthorized = await fetch(harness.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(unauthorized.status, 401);

    const client = await connect(harness, { Authorization: "Bearer test-token-abcdef" });
    const { tools } = await client.listTools();
    assert.equal(tools[0]?.name, "gtm_search");
    await client.close();
  } finally {
    await harness.close();
  }
});

test("GET and DELETE are rejected in stateless mode", async () => {
  const harness = await startHarness({ llm: fakeLlm(() => finalAnswer("unused")) });
  try {
    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(harness.url, { method });
      assert.equal(res.status, 405);
      assert.equal(res.headers.get("allow"), "POST");
    }
  } finally {
    await harness.close();
  }
});

test("a non-local Host header is rejected by DNS rebinding protection", async () => {
  const harness = await startHarness({ llm: fakeLlm(() => finalAnswer("unused")) });
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: harness.url.port,
          path: "/mcp",
          method: "POST",
          headers: {
            host: "evil.example.com",
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    });
    assert.equal(status, 403);
  } finally {
    await harness.close();
  }
});
