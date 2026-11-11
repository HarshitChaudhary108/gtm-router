import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { authenticate, type AuthOptions } from "./auth.js";
import type { Config } from "./config.js";
import { AppError, toAppError } from "./errors.js";
import type { KeyResolver } from "./keys.js";
import type { ToolCatalog } from "./tools.js";
import { isRecord } from "./util.js";

/**
 * Connections page: where a user adds their own provider keys.
 *
 *   GET  /connections               the page (static; the token is asked for in the browser)
 *   GET  /connections/api/state     which providers this user has connected (Bearer token)
 *   POST /connections/api/session   start a Nango Connect session for one provider
 *   POST /connections/api/refresh   forget the cached keys right after a connect
 *
 * Keys are pasted into Nango's own Connect screen. They never pass through this server and are
 * never shown in chat.
 */

const FRONTEND = "https://cdn.jsdelivr.net/npm/@nangohq/frontend@0.72.4/+esm";
const MAX_BODY = 4 * 1024;

const LABELS: Record<string, string> = {
  tavily: "Tavily",
  jina: "Jina",
  moltsets: "MoltSets",
  apollo: "Apollo",
  hunter: "Hunter",
  parallel: "Parallel",
  you: "You.com",
  linkup: "Linkup",
  firecrawl: "Firecrawl",
  serper: "Serper",
  apify: "Apify",
  browserbase: "Browserbase",
};

const label = (slot: string): string => LABELS[slot] ?? slot.charAt(0).toUpperCase() + slot.slice(1);

export interface ConnectionsDeps {
  config: Pick<Config, "nangoHost" | "sharedKeys">;
  auth: AuthOptions;
  keys: KeyResolver;
  catalog: ToolCatalog;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new AppError("E_BODY_TOO_LARGE", "Request body is too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    throw new AppError("E_VALIDATION", "Body must be JSON");
  }
}

function pageHtml(nonce: string, nangoEnabled: boolean): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>outmate connections</title>
<style>
:root{--bg:#f7f7f5;--card:#fff;--text:#1a1a1a;--muted:#6b6b6b;--line:#e3e3df;--accent:#1e3a5f;--accent-text:#fff;--ok:#0f766e;--warn:#b45309;--err:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--card:#1c1c1c;--text:#f0f0f0;--muted:#9a9a9a;--line:#2e2e2e;--accent:#8fb3e0;--accent-text:#0b1a2b;--ok:#5eead4;--warn:#fbbf24;--err:#ff8a7a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:24px 16px}
main{max-width:560px;margin:0 auto}h1{font-size:24px;margin:0 0 4px}p{margin:0 0 18px;color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:12px 0}
.row{display:flex;align-items:center;justify-content:space-between;gap:12px;border-top:1px solid var(--line);padding:12px 0}.row:first-child{border-top:0}
.name{font-weight:600}.sub{font-size:13px;color:var(--muted)}
.tag{font-size:12px;font-weight:600;border:1px solid currentColor;border-radius:999px;padding:2px 9px;white-space:nowrap}
.own{color:var(--ok)}.shared{color:var(--warn)}.none{color:var(--muted)}
input{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text);font-size:16px}
button{padding:9px 14px;border:0;border-radius:8px;background:var(--accent);color:var(--accent-text);font-size:14px;font-weight:600;cursor:pointer}
button[disabled]{opacity:.5;cursor:default}.err{color:var(--err);margin:10px 0 0;font-size:14px}.note{font-size:13px;color:var(--muted)}
</style></head><body><main>
<h1>Your provider keys</h1>
<p>Add each key once. It is stored by Nango, linked to you, and never typed into chat.</p>
<div class="card" id="login">
  <label for="t" class="name">Your outmate token</label>
  <p class="sub" style="margin:4px 0 10px">The token you got when you signed up. It stays in this tab only.</p>
  <input id="t" type="password" autocomplete="off" placeholder="outmate_...">
  <div style="margin-top:12px"><button id="go">Continue</button></div>
  <div class="err" id="e1" hidden></div>
</div>
<div id="list" hidden>
  <div class="card" id="rows"></div>
  <p class="note" id="foot"></p>
</div>
<script type="module" nonce="${nonce}">
const nangoEnabled = ${nangoEnabled ? "true" : "false"};
const $ = (id) => document.getElementById(id);
let token = sessionStorage.getItem("outmate_token") || "";
const api = async (path, init = {}) => {
  const res = await fetch(path, { ...init, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));
  return body;
};
const TAG = { own: ["Your key", "own"], shared: ["Shared key", "shared"], none: ["Not connected", "none"] };
function render(state) {
  $("login").hidden = true; $("list").hidden = false;
  const rows = $("rows"); rows.textContent = "";
  for (const p of state.providers) {
    const row = document.createElement("div"); row.className = "row";
    const left = document.createElement("div");
    const n = document.createElement("div"); n.className = "name"; n.textContent = p.label;
    const s = document.createElement("div"); s.className = "sub"; s.textContent = p.tools.join(" · ");
    left.append(n, s);
    const right = document.createElement("div"); right.style.display = "flex"; right.style.gap = "10px"; right.style.alignItems = "center";
    const [text, cls] = TAG[p.source];
    const tag = document.createElement("span"); tag.className = "tag " + cls; tag.textContent = text; right.append(tag);
    if (state.nango) {
      const b = document.createElement("button"); b.textContent = p.source === "own" ? "Replace" : "Connect";
      b.onclick = () => connect(p.id, b);
      right.append(b);
    }
    row.append(left, right); rows.append(row);
  }
  $("foot").textContent = (state.nango ? "" : "Nango is not set up on this server, so the server's own keys are used. ") +
    "Signed in as " + state.user + ".";
}
async function load() { render(await api("/connections/api/state")); }
async function connect(provider, btn) {
  btn.disabled = true;
  try {
    const { token: session } = await api("/connections/api/session", { method: "POST", body: JSON.stringify({ provider }) });
    const { default: Nango } = await import("${FRONTEND}");
    const nango = new Nango();
    const ui = nango.openConnectUI({
      onEvent: async (event) => {
        if (event.type === "connect") { await api("/connections/api/refresh", { method: "POST", body: "{}" }); await load(); }
        if (event.type === "close") btn.disabled = false;
      },
    });
    ui.setSessionToken(session);
  } catch (err) {
    btn.disabled = false; $("foot").textContent = "Could not start: " + err.message;
  }
}
$("go").onclick = async () => {
  token = $("t").value.trim(); $("e1").hidden = true;
  try { await load(); sessionStorage.setItem("outmate_token", token); }
  catch (err) { $("e1").textContent = err.message === "Unauthorized" ? "That token was not accepted." : err.message; $("e1").hidden = false; }
};
if (token) load().catch(() => sessionStorage.removeItem("outmate_token"));
</script></main></body></html>`;
}

/** Returns true when the request was handled here. */
export function createConnections(deps: ConnectionsDeps) {
  return async (req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> => {
    if (path !== "/connections" && !path.startsWith("/connections/api/")) return false;

    try {
      if (path === "/connections") {
        if (req.method !== "GET") {
          res.setHeader("Allow", "GET");
          sendJson(res, 405, { error: "Use GET" });
          return true;
        }
        const nonce = randomBytes(16).toString("base64");
        const nango = new URL(deps.config.nangoHost).origin;
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Frame-Options": "DENY",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Content-Security-Policy":
            `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net; ` +
            `connect-src 'self' ${nango} https://api.nango.dev; frame-src https://connect.nango.dev; ` +
            `img-src 'self' https: data:; base-uri 'none'; form-action 'none'`,
        });
        res.end(pageHtml(nonce, deps.keys.nangoEnabled()));
        return true;
      }

      const identity = authenticate(req, deps.auth);
      if (!identity) {
        sendJson(res, 401, { error: "Unauthorized" });
        return true;
      }
      const user = identity.name;
      const slots = deps.catalog.keySlots();

      if (path === "/connections/api/state" && req.method === "GET") {
        const resolved = await deps.keys.forUser(user, slots);
        sendJson(res, 200, {
          user,
          nango: deps.keys.nangoEnabled(),
          shared_keys: deps.config.sharedKeys,
          providers: slots.map((slot) => ({
            id: slot,
            label: label(slot),
            source: resolved.source[slot] ?? "none",
            tools: [...new Set(deps.catalog.list().filter((t) => t.key === slot).map((t) => t.capability))],
          })),
        });
        return true;
      }

      if (path === "/connections/api/session" && req.method === "POST") {
        const body = await readJson(req);
        const provider = typeof body.provider === "string" ? body.provider : "";
        if (!slots.includes(provider)) throw new AppError("E_VALIDATION", "Unknown provider");
        sendJson(res, 200, await deps.keys.createConnectSession(user, provider));
        return true;
      }

      if (path === "/connections/api/refresh" && req.method === "POST") {
        deps.keys.invalidate(user);
        sendJson(res, 200, { ok: true });
        return true;
      }

      sendJson(res, 404, { error: "Not found" });
      return true;
    } catch (err) {
      const error = toAppError(err);
      sendJson(res, error.status, { error: error.message });
      return true;
    }
  };
}
