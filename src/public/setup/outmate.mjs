#!/usr/bin/env node
// outmate: command line client for a outmate server. Single file, no dependencies, Node 18+.
// Published to npm as `outmate` (commands `outmate` and `outmate`) and also served by the server at /outmate.mjs.
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const VERSION = "0.1.1";
// Replaced with the server's own URL when served from /outmate.mjs. Left as is in the npm package.
const DEFAULT_URL = "{{HOST}}";
const HOME = process.env.OUTMATE_HOME || join(homedir(), ".outmate");
const CREDS = join(HOME, "credentials");
const SERVER_NAME = "outmate";
const run = promisify(execFile);

const USAGE = `outmate ${VERSION}: client for outmate

  outmate login --url <server> --token <token>   sign in and save the token
  outmate connect [--agent <name>]               add the MCP server and skill to your agents
  outmate [status]                               check token and providers
  outmate search "<question>"                    ask outmate_search from the terminal
  outmate logout                                 remove the saved token

Agents: claude, cursor, codex, vscode, gemini, opencode, windsurf
`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parse(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) rest.push(arg);
    else if (arg === "--help" || arg === "--version") flags[arg.slice(2)] = true;
    else if (arg.includes("=")) flags[arg.slice(2, arg.indexOf("="))] = arg.slice(arg.indexOf("=") + 1);
    else flags[arg.slice(2)] = argv[++i];
  }
  return { flags, rest };
}

function cleanUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`Not a valid URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") fail("Server URL must start with http:// or https://");
  return url.origin;
}

function loadCreds() {
  try {
    const creds = JSON.parse(readFileSync(CREDS, "utf8"));
    return creds.url && creds.token ? creds : null;
  } catch {
    return null;
  }
}

/** Writes a file readable only by the user. `mode` alone applies only to new files, hence chmod. */
function writePrivate(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
}

function saveCreds(creds) {
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  writePrivate(CREDS, JSON.stringify(creds));
}

function requireCreds() {
  return loadCreds() ?? fail("Not signed in. Run: outmate login --url <server> --token <token>");
}

async function whoami(url, token) {
  try {
    const res = await fetch(`${url}/whoami`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    return { status: res.status, body: res.ok ? await res.json() : null };
  } catch {
    return fail(`Cannot reach ${url}. Check the URL and your network.`);
  }
}

async function login(flags) {
  const token = flags.token || process.env.OUTMATE_TOKEN;
  if (!token) fail("Missing token. Use: outmate login --url <server> --token <token>");
  const base = flags.url || process.env.OUTMATE_URL || (DEFAULT_URL.startsWith("{{") ? "" : DEFAULT_URL);
  if (!base) fail("Missing server URL. Use: outmate login --url <server> --token <token>");
  const url = cleanUrl(base);
  const { status, body } = await whoami(url, token);
  if (status === 401) fail("Token rejected. Ask the operator for a new one.");
  if (!body) fail(`Server answered HTTP ${status}.`);
  saveCreds({ url, token });
  console.log(`Signed in to ${url} as "${body.name}".`);
  console.log("Next: outmate connect");
}

async function status() {
  const { url, token } = requireCreds();
  const { status: code, body } = await whoami(url, token);
  if (code === 401) fail("Saved token was rejected (revoked?). Run: outmate login --url <server> --token <token>");
  if (!body) fail(`Server answered HTTP ${code}.`);
  console.log(`Server:    ${url}`);
  console.log(`Signed in: ${body.name}`);
  const on = Object.entries(body.providers).filter(([, v]) => v).map(([k]) => k);
  const off = Object.entries(body.providers).filter(([, v]) => !v).map(([k]) => k);
  console.log(`Providers: ${on.join(", ") || "none"}`);
  if (off.length) console.log(`Not configured: ${off.join(", ")}`);
  console.log('Try: outmate search "Find engineering leaders at vercel.com"');
}

// ---------- connect: one entry per agent ----------

async function hasCommand(name) {
  try {
    await run(name, ["--version"]);
    return true;
  } catch {
    return false;
  }
}

/** Reads a JSON config, or {} when missing. Throws a readable error when the file is not JSON. */
function readJson(file) {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new Error(`${file} is not plain JSON (comments?). Fix it, then run outmate connect --agent again.`);
  }
}

/** Merges one server entry under `key` and keeps everything else in the file. */
function mergeJson(file, key, entry) {
  const config = readJson(file);
  config[key] = { ...(config[key] && typeof config[key] === "object" ? config[key] : {}), [SERVER_NAME]: entry };
  writePrivate(file, `${JSON.stringify(config, null, 2)}\n`);
}

function vscodeUserDir(home) {
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Code", "User");
  if (process.platform === "win32") return join(process.env.APPDATA || join(home, "AppData", "Roaming"), "Code", "User");
  return join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "Code", "User");
}

const tomlString = (value) => JSON.stringify(value); // a JSON string is a valid TOML basic string

/** Replaces the [mcp_servers.outmate] table (and its subtables) in a Codex config.toml. */
function upsertCodexToml(text, url, auth) {
  const header = `[mcp_servers.${SERVER_NAME}]`;
  const out = [];
  let skipping = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      const name = trimmed.replace(/^\[+|\]+.*$/g, "").trim();
      skipping = name === `mcp_servers.${SERVER_NAME}` || name.startsWith(`mcp_servers.${SERVER_NAME}.`);
    }
    if (!skipping) out.push(line);
  }
  const body = out.join("\n").replace(/\n+$/, "");
  const block = `${header}\nurl = ${tomlString(url)}\nhttp_headers = { "Authorization" = ${tomlString(auth)} }\n`;
  return body ? `${body}\n\n${block}` : block;
}

function agents(home) {
  const codexHome = process.env.CODEX_HOME || join(home, ".codex");
  return [
    {
      id: "claude",
      label: "Claude Code",
      detect: () => hasCommand("claude"),
      async add(url, token) {
        await run("claude", ["mcp", "remove", "--scope", "user", SERVER_NAME]).catch(() => undefined);
        await run("claude", [
          "mcp", "add", "--scope", "user", "--transport", "http", SERVER_NAME, `${url}/mcp`,
          "--header", `Authorization: Bearer ${token}`,
        ]);
        return "added (user scope)";
      },
      skillDir: join(process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "skills", SERVER_NAME),
    },
    {
      id: "cursor",
      label: "Cursor",
      detect: async () => existsSync(join(home, ".cursor")),
      add(url, token) {
        const file = join(home, ".cursor", "mcp.json");
        mergeJson(file, "mcpServers", { url: `${url}/mcp`, headers: { Authorization: `Bearer ${token}` } });
        return `added to ${file}`;
      },
    },
    {
      id: "codex",
      label: "Codex",
      detect: async () => existsSync(codexHome) || (await hasCommand("codex")),
      add(url, token) {
        const file = join(codexHome, "config.toml");
        const text = existsSync(file) ? readFileSync(file, "utf8") : "";
        writePrivate(file, upsertCodexToml(text, `${url}/mcp`, `Bearer ${token}`));
        return `added to ${file}`;
      },
      skillDir: join(codexHome, "skills", SERVER_NAME),
    },
    {
      id: "vscode",
      label: "VS Code",
      detect: async () => existsSync(vscodeUserDir(home)),
      add(url, token) {
        const file = join(vscodeUserDir(home), "mcp.json");
        mergeJson(file, "servers", { type: "http", url: `${url}/mcp`, headers: { Authorization: `Bearer ${token}` } });
        return `added to ${file}`;
      },
    },
    {
      id: "gemini",
      label: "Gemini CLI",
      detect: async () => existsSync(join(home, ".gemini")) || (await hasCommand("gemini")),
      add(url, token) {
        const file = join(home, ".gemini", "settings.json");
        mergeJson(file, "mcpServers", { httpUrl: `${url}/mcp`, headers: { Authorization: `Bearer ${token}` } });
        return `added to ${file}`;
      },
    },
    {
      id: "opencode",
      label: "opencode",
      detect: async () => existsSync(join(home, ".config", "opencode")) || (await hasCommand("opencode")),
      add(url, token) {
        const file = join(home, ".config", "opencode", "opencode.json");
        const fresh = !existsSync(file);
        mergeJson(file, "mcp", { type: "remote", url: `${url}/mcp`, enabled: true, headers: { Authorization: `Bearer ${token}` } });
        if (fresh) {
          const config = readJson(file);
          writePrivate(file, `${JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config }, null, 2)}\n`);
        }
        return `added to ${file}`;
      },
    },
    {
      id: "windsurf",
      label: "Windsurf",
      detect: async () => existsSync(join(home, ".codeium", "windsurf")),
      add(url, token) {
        const file = join(home, ".codeium", "windsurf", "mcp_config.json");
        mergeJson(file, "mcpServers", { serverUrl: `${url}/mcp`, headers: { Authorization: `Bearer ${token}` } });
        return `added to ${file}`;
      },
    },
  ];
}

/** Fetches the server's skill.md and installs it as SKILL.md, so later sessions load it on their own. */
async function fetchSkill(url) {
  try {
    const res = await fetch(`${url}/skill.md`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const body = await res.text();
    return [
      "---",
      `name: ${SERVER_NAME}`,
      "description: GTM research through the outmate_search MCP tool - companies, people, job titles, business emails, headcount and reading a web page. Use it whenever a task needs live company or people data.",
      "---",
      "",
      body,
    ].join("\n");
  } catch {
    return null;
  }
}

async function connect(flags) {
  const { url, token } = requireCreds();
  const all = agents(homedir());
  const want = flags.agent;
  if (want && !all.some((a) => a.id === want)) fail(`--agent must be one of: ${all.map((a) => a.id).join(", ")}`);

  const chosen = [];
  for (const agent of all) {
    if (want ? agent.id === want : await agent.detect()) chosen.push(agent);
  }
  if (!chosen.length) {
    console.log("No supported agent found. Add this MCP server by hand:");
    console.log(`  URL:    ${url}/mcp  (streamable HTTP)`);
    console.log("  Header: Authorization: Bearer <your token>");
    return;
  }

  const skill = chosen.some((a) => a.skillDir) ? await fetchSkill(url) : null;
  let failed = 0;
  for (const agent of chosen) {
    try {
      let line = `${agent.label}: ${await agent.add(url, token)}`;
      if (agent.skillDir && skill) {
        writePrivate(join(agent.skillDir, "SKILL.md"), skill);
        line += ", skill installed";
      }
      console.log(line);
    } catch (err) {
      failed++;
      console.log(`${agent.label}: not configured. ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log("Restart each agent (or start a new session) to load outmate.");
  console.log(`To use your own provider keys, open ${url}/connections`);
  if (failed === chosen.length) process.exit(1);
}

async function search(query) {
  if (!query) fail('Usage: outmate search "<question>"');
  const { url, token } = requireCreds();
  let res;
  try {
    res = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "outmate_search", arguments: { query } },
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    return fail(`Cannot reach ${url}.`);
  }
  if (res.status === 401) fail("Token rejected. Run: outmate login --url <server> --token <token>");
  const raw = await res.text();
  const json = raw.includes("data:") ? raw.split("\n").filter((l) => l.startsWith("data:")).pop().slice(5) : raw;
  let message;
  try {
    message = JSON.parse(json);
  } catch {
    return fail(`Unexpected server reply (HTTP ${res.status}).`);
  }
  if (message.error) fail(`Server error: ${message.error.message}`);
  const text = (message.result?.content ?? []).map((c) => c.text).filter(Boolean).join("\n");
  console.log(text || "(empty result)");
  if (message.result?.isError) process.exit(1);
}

const { flags, rest } = parse(process.argv.slice(2));
const command = flags.help ? "help" : flags.version ? "version" : (rest[0] ?? "status");

try {
  if (command === "login") await login(flags);
  else if (command === "status") await status();
  else if (command === "connect") await connect(flags);
  else if (command === "search") await search(rest.slice(1).join(" ").trim());
  else if (command === "logout") {
    rmSync(CREDS, { force: true });
    console.log("Signed out. Agent configs keep the old token until it is revoked or you run outmate connect again.");
  } else if (command === "help") console.log(USAGE);
  else if (command === "version") console.log(VERSION);
  else fail(`Unknown command: ${command}\n\n${USAGE}`);
} catch (err) {
  fail(`outmate failed: ${err instanceof Error ? err.message : "unknown error"}`);
}
