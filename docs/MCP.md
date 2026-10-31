# GTM Router over MCP (Claude.ai connector)

The MCP server exposes **one tool**, `gtm_search`, which forwards the query to the existing
router unchanged: the LLM picks registered actions, the engine executes them against the
configured providers, and the normalized envelope comes back. There is no second routing
algorithm in the adapter.

```
Claude.ai ──MCP/Streamable HTTP──▶ gtm-router MCP adapter ──▶ existing router ──▶ providers
```

The MCP server is embedded in this repository and is meant for **local development**. It
does not need the REST server running; the router is imported directly.

---

## 1. Configure

Copy `.env.example` to `.env` if you have not already, then fill in at least:

```bash
LLM_API_KEY=...          # required for natural-language routing
LLM_MODEL=deepseek-v4-flash
TAVILY_API_KEY=...       # required for web.search
JINA_API_KEY=...         # required for web.read_url
MOLTSETS_API_KEY=...     # optional: companies/people
# optional: PARALLEL/YOU/LINKUP/FIRECRAWL/SERPER/APIFY/BROWSERBASE/APOLLO/HUNTER keys
MCP_PORT=3333
MCP_HOST=127.0.0.1
# MCP_AUTH_TOKEN=       # optional bearer token, off by default
```

`.env` is gitignored and must never be committed. Keys are only read from the environment;
they are not logged, returned in tool responses, or sent to the MCP client.

## 2. Start

```bash
npm run mcp          # tsx, development
# or
npm run build && npm run start:mcp
```

Startup prints the endpoint, which providers have keys, and whether auth is on:

```
MCP server ready at http://127.0.0.1:3333/mcp
providers: tavily=true jina=true moltsets=true ...
auth: off
```

Health check:

```bash
curl -s http://127.0.0.1:3333/health
# {"status":"ok","service":"gtm-router-mcp","endpoint":"/mcp","config":{...booleans...},"auth":false}
```

## 3. Verify locally with MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```

- Transport: **Streamable HTTP**
- URL: `http://127.0.0.1:3333/mcp`
- Connect → **List Tools** should show `gtm_search` → **Call Tool** with
  `{"query":"Find engineering leaders at vercel.com."}`.

The text result contains the answer, any company/person rows, source URLs, and the execution
trace (`action:provider`). `structuredContent` carries the full normalized envelope. A failed
run sets `isError: true`; errors are redacted.

Protocol notes: `/mcp` accepts **POST only** (GET/DELETE return 405 with `Allow: POST`).
Requests with an unexpected `Host` header are rejected when DNS-rebinding protection is on.
The transport is stateless, so no session id is issued.

## 4. Expose to Claude.ai through an HTTPS tunnel

Claude.ai cannot reach `localhost`. Use a tunnel that preserves the loopback `Host` header:

```bash
ngrok http 3333 --host-header=rewrite
```

Take the `https://<ngrok-host>` URL, and in Claude.ai open **Settings → Connectors → Add
custom connector** with:

- Name: `GTM Router`
- URL: `https://<ngrok-host>/mcp`
- Transport: Streamable HTTP

Then ask a question in a chat; Claude should call `gtm_search` and cite the returned sources.

### Making Claude actually call it

Claude chooses tools per message from every enabled connector plus its built-in web search; the
server cannot force a call. The tool description and server instructions now claim company,
contact, email and firmographic intents explicitly and say to prefer this tool over web search
for them. To maximize the odds:

- Remove any older/duplicate company-people connectors (for example a standalone MoltSets
  connector). Near-duplicate tools split the model's preference.
- Enable **GTM Router** for the conversation — connectors are toggled per chat.
- If a research prompt still goes to built-in web search, say once: "use the GTM Router
  `gtm_search` tool". The rest of that conversation will usually stay on it.

The model's choice is probabilistic; there is no "always invoke" toggle in Claude.ai.

If the connector dialog offers a static auth header, set `MCP_AUTH_TOKEN` and send
`Authorization: Bearer <token>`. Support for static headers varies by client version. If it
is not available, leave the token unset and keep the tunnel short-lived — anyone with the URL
can call the tool and spend provider credits.

## 5. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Connector can't connect | Claude.ai needs public HTTPS; check the tunnel is up and the URL ends in `/mcp`. |
| `403` from the MCP server | `Host` header not preserved by the tunnel. With ngrok use `--host-header=rewrite`. |
| `401` | `MCP_AUTH_TOKEN` is set but the client did not send `Authorization: Bearer <token>`. |
| `405 Allow: POST` | The client used GET/DELETE; this server is POST-only by design. |
| Tool returns `E_CONFIG` | `LLM_API_KEY`/`LLM_MODEL` (router) or the key for the requested provider is missing. `/health` shows which. |
| Tool returns `E_QUOTA` (402) | Provider plan limit reached; no app retry will fix it. |
| Tool returns `E_RATE_LIMIT` (429) | Upstream rate limit; wait and retry. |
| `Input validation error` | Empty or over-long `query`; the tool caps input at the router's request-size limit. |
| Tool call succeeds but answer is thin | Check the execution trace and sources in the same result; the model may have stopped early. |
