import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "./errors.js";
import { fetchWithRetry, readJsonBody, readTextCapped, assertUpstreamOk, type FetchLike } from "./http.js";
import { isRecord, truncate } from "./util.js";

export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
}

/** How an `http` tool calls its provider. Host and scheme are fixed in the file, never templated. */
export type JsonLike = string | number | boolean | null | JsonLike[] | { [k: string]: JsonLike };

export interface HttpAuthSpec {
  /**
   * header: `<name>: <prefix><secret>`   query: `?<name>=<secret>`   bearer: `Authorization: Bearer <secret>`
   * basic: `Authorization: Basic` with the secret as the user name (or as the password when `user` is set).
   */
  in: "header" | "query" | "bearer" | "basic";
  name?: string;
  /** Text placed before the secret in a header, e.g. "Token " or "Bearer:". */
  prefix?: string;
  /** basic only: a fixed user name. Use "" for providers that want an empty user. */
  user?: string;
  /**
   * For a provider that needs two credentials: the user saves them as one key joined by a colon
   * ("first:second"). `part` picks which half this header or parameter carries (0 or 1).
   */
  part?: 0 | 1;
  /** "exchange": send the token from `request.token_exchange` instead of the key. */
  from?: "key" | "exchange";
}

/** Swap the saved key for a short-lived access token first (OAuth client credentials). */
export interface TokenExchangeSpec {
  /** https, fixed host. */
  url: string;
  /** JSON body. `{key.0}` and `{key.1}` are the two halves of the key. */
  body: Record<string, JsonLike>;
  /** Where the token is in the response. Default "access_token". */
  token_path?: string;
  /** Seconds the token lives. Default "expires_in", else 5 minutes. */
  expires_path?: string;
}

/** The host comes from the user's own connection (e.g. a Salesforce instance), limited to allowed domains. */
export interface BaseFromSpec {
  /** Field on the connection, e.g. "instance_url". */
  field: string;
  /** The host must end with one of these, each starting with a dot, e.g. ".salesforce.com". */
  suffixes: string[];
}

export interface HttpRequestSpec {
  method: "GET" | "POST";
  /** https URL. `{param}` may appear in the path only. With `base_from`, just the path, starting with "/". */
  url: string;
  /** Take the host from the user's connection instead of the file. */
  base_from?: BaseFromSpec;
  /** Exchange the key for an access token before the call. */
  token_exchange?: TokenExchangeSpec;
  /** Query parameters. A value of exactly `{param}` is dropped when the model leaves that input out. */
  query?: Record<string, JsonLike>;
  /** JSON body. Nested objects and lists are allowed; `{param}` is filled anywhere inside. */
  body?: Record<string, JsonLike>;
  /** Fixed extra headers, e.g. a User-Agent a public API asks for. */
  headers?: Record<string, string>;
  /** Where the user's key goes. A list sends several parts. Leave out for public APIs that need no key. */
  auth?: HttpAuthSpec | HttpAuthSpec[];
  /** "json" (default) or "text" for providers that answer with plain text or markdown. */
  response?: "json" | "text";
  /** Dot path into the JSON response to hand to the model, e.g. "data.results" or "items.0". */
  result_path?: string;
  /** Slow providers only: wait longer than the default (at most 60000). */
  timeout_ms?: number;
}

/**
 * One tool = one file in `tools/`. `builtin` tools are backed by code (their own validation and
 * result shape); `http` tools are fully described by `request` and need no code at all.
 */
export interface ToolFile {
  /** Position in the model's tool list. Lower comes first; default 100. */
  order?: number;
  /** Unique action name, e.g. "outmate.hunter_domain" or "custom.hunter_email_count". */
  name: string;
  /** Name the router's model sees. */
  tool: string;
  kind: "builtin" | "http" | "internal";
  /** internal tools only: which function in code runs it (see INTERNAL_HANDLERS). */
  handler?: string;
  /** Key slot. Also the Nango integration id the user's key is saved under. "" for public APIs. */
  key: string;
  /** Shown under the provider on the Connections page, e.g. how to paste a two-part key. */
  key_help?: string;
  /** Group name on the Connections page, e.g. "People & contact data". */
  category?: string;
  /** When true the tool is only offered to a user who has a key for `key`. */
  needs_key: boolean;
  /** Short phrase used to build the outmate_search description. */
  capability: string;
  description: string;
  parameters: JsonSchemaObject;
  request?: HttpRequestSpec;
}

/** Tools whose logic lives in code, not in a request description. A tool file picks one by name. */
export const INTERNAL_HANDLERS = ["hubspot_propose_contacts"] as const;

const TOOL_RE = /^[a-z][a-z0-9_]{0,47}$/;
const KEY_RE = /^[a-z][a-z0-9_-]{0,31}$/;

function fail(file: string, message: string): never {
  throw new Error(`${file}: ${message}`);
}

function collectPlaceholders(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    for (const m of value.matchAll(/\{([a-z][a-z0-9_]*)\}/g)) into.add(m[1]!);
  } else if (Array.isArray(value)) {
    for (const v of value) collectPlaceholders(v, into);
  } else if (isRecord(value)) {
    for (const v of Object.values(value)) collectPlaceholders(v, into);
  }
}

/** Check one parsed tool file. Throws a plain Error naming the file and the problem. */
export function checkToolFile(raw: unknown, file = "tool"): ToolFile {
  if (!isRecord(raw)) fail(file, "must be a JSON object");
  const { name, tool, kind, needs_key, capability, description, parameters, request } = raw;
  let key = raw.key;
  if (typeof name !== "string" || !name) fail(file, "name is required");
  if (typeof tool !== "string" || !TOOL_RE.test(tool)) fail(file, "tool must be snake_case, up to 48 characters");
  if (kind !== "builtin" && kind !== "http" && kind !== "internal") fail(file, 'kind must be "builtin", "http" or "internal"');
  if (kind === "internal" && !(INTERNAL_HANDLERS as readonly unknown[]).includes(raw.handler)) {
    fail(file, `internal tools need a handler: one of ${INTERNAL_HANDLERS.join(", ")}`);
  }
  const publicApi = kind === "http" && isRecord(request) && request.auth === undefined;
  if (publicApi && (key === undefined || key === "")) {
    key = "";
    (raw as Record<string, unknown>).key = "";
  } else if (typeof key !== "string" || !KEY_RE.test(key)) {
    fail(file, "key must be a lowercase id such as hunter");
  }
  if (typeof needs_key !== "boolean") fail(file, "needs_key must be true or false");
  if (publicApi && needs_key) fail(file, "a tool with no request.auth cannot set needs_key");
  if (raw.category !== undefined && typeof raw.category !== "string") fail(file, "category must be text");
  if (raw.key_help !== undefined && (typeof raw.key_help !== "string" || raw.key_help.length > 200)) fail(file, "key_help must be short text");
  if (typeof capability !== "string" || !capability) fail(file, "capability is required");
  if (typeof description !== "string" || description.length < 10) fail(file, "description is required");
  if (!isRecord(parameters) || parameters.type !== "object" || !isRecord(parameters.properties)) {
    fail(file, "parameters must be a JSON schema object with properties");
  }
  if (!Array.isArray(parameters.required)) fail(file, "parameters.required must be a list");
  if (parameters.additionalProperties !== false) fail(file, "parameters.additionalProperties must be false");

  if (kind === "http") {
    if (!isRecord(request)) fail(file, "http tools need a request");
    if (request.method !== "GET" && request.method !== "POST") fail(file, "request.method must be GET or POST");
    if (typeof request.url !== "string") fail(file, "request.url is required");
    if (request.base_from !== undefined) {
      const base = request.base_from;
      const ok =
        isRecord(base) && typeof base.field === "string" && base.field !== "" &&
        Array.isArray(base.suffixes) && base.suffixes.length > 0 &&
        base.suffixes.every((x) => typeof x === "string" && /^\.[a-z0-9.-]+\.[a-z]+$/.test(x));
      if (!ok) fail(file, 'request.base_from needs a field and suffixes like ".salesforce.com"');
      if (!request.url.startsWith("/")) fail(file, "with base_from, request.url must be a path starting with /");
    } else {
      let url: URL;
      try {
        url = new URL(request.url.replace(/\{[a-z_]+\}/g, "x"));
      } catch {
        fail(file, "request.url is not a valid URL");
      }
      if (url.protocol !== "https:") fail(file, "request.url must be https");
      const host = request.url.slice("https://".length).split("/")[0] ?? "";
      if (host.includes("{")) fail(file, "request.url host must be fixed, not templated");
    }
    if (request.token_exchange !== undefined) {
      const ex = request.token_exchange;
      if (!isRecord(ex) || typeof ex.url !== "string" || !ex.url.startsWith("https://") || !isRecord(ex.body)) {
        fail(file, "request.token_exchange needs an https url and a body");
      }
      if ((ex.url as string).slice("https://".length).split("/")[0]!.includes("{")) fail(file, "token_exchange host must be fixed");
    }
    if (request.auth !== undefined) {
      const parts = Array.isArray(request.auth) ? request.auth : [request.auth];
      if (parts.length === 0) fail(file, "request.auth must not be empty");
      for (const auth of parts) {
        if (!isRecord(auth) || !["header", "query", "bearer", "basic"].includes(String(auth.in))) {
          fail(file, 'request.auth.in must be "header", "query", "bearer" or "basic"');
        }
        if ((auth.in === "header" || auth.in === "query") && typeof auth.name !== "string") {
          fail(file, "request.auth.name is required for header and query auth");
        }
        if (auth.prefix !== undefined && typeof auth.prefix !== "string") fail(file, "request.auth.prefix must be text");
        if (auth.user !== undefined && typeof auth.user !== "string") fail(file, "request.auth.user must be text");
        if (auth.part !== undefined && auth.part !== 0 && auth.part !== 1) fail(file, "request.auth.part must be 0 or 1");
        if (auth.from !== undefined && auth.from !== "key" && auth.from !== "exchange") fail(file, 'request.auth.from must be "key" or "exchange"');
        if (auth.from === "exchange" && request.token_exchange === undefined) fail(file, 'auth from "exchange" needs request.token_exchange');
      }
    }
    if (request.response !== undefined && request.response !== "json" && request.response !== "text") {
      fail(file, 'request.response must be "json" or "text"');
    }
    if (request.headers !== undefined) {
      const ok = isRecord(request.headers) && Object.values(request.headers).every((v) => typeof v === "string");
      if (!ok) fail(file, "request.headers must be a map of text");
    }
    if (request.timeout_ms !== undefined) {
      if (typeof request.timeout_ms !== "number" || request.timeout_ms < 1000 || request.timeout_ms > 60_000) {
        fail(file, "request.timeout_ms must be between 1000 and 60000");
      }
    }
    // Every {placeholder} must be a declared input, so a typo is caught when the file loads.
    const declared = new Set(Object.keys(parameters.properties));
    const used = new Set<string>();
    collectPlaceholders(request.url, used);
    collectPlaceholders(request.query, used);
    collectPlaceholders(request.body, used);
    for (const p of used) if (!declared.has(p)) fail(file, `{${p}} is used in the request but is not in parameters`);
  }
  return raw as unknown as ToolFile;
}

/** Default folder: `tools/` at the repo root (also works from `dist/`). */
export function defaultToolsDir(): string {
  return process.env.OUTMATE_TOOLS_DIR?.trim() || fileURLToPath(new URL("../tools/", import.meta.url));
}

/**
 * The folder of tool files, reloaded whenever a file is added, edited or removed. Adding a tool
 * therefore needs no restart. A broken file is skipped and reported, never fatal.
 */
export class ToolCatalog {
  private signature = "";
  private tools: ToolFile[] = [];
  private problems: string[] = [];

  constructor(private readonly dir: string = defaultToolsDir()) {}

  private refresh(): void {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith(".json")).sort();
    } catch {
      this.signature = "";
      this.tools = [];
      this.problems = [`tools folder not found: ${this.dir}`];
      return;
    }
    const signature = names.map((n) => `${n}:${statSync(join(this.dir, n)).mtimeMs}`).join("|");
    if (signature === this.signature) return;

    const tools: ToolFile[] = [];
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const n of names) {
      try {
        const tool = checkToolFile(JSON.parse(readFileSync(join(this.dir, n), "utf8")), n);
        if (seen.has(tool.name) || seen.has(`tool:${tool.tool}`)) fail(n, "duplicate name or tool");
        seen.add(tool.name).add(`tool:${tool.tool}`);
        tools.push(tool);
      } catch (err) {
        problems.push(err instanceof Error ? err.message : String(err));
      }
    }
    tools.sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.name.localeCompare(b.name));
    this.signature = signature;
    this.tools = tools;
    this.problems = problems;
    for (const p of problems) console.error(`tools: skipped ${p}`);
  }

  list(): ToolFile[] {
    this.refresh();
    return this.tools;
  }

  issues(): string[] {
    this.refresh();
    return this.problems;
  }

  byTool(tool: string): ToolFile | undefined {
    return this.list().find((t) => t.tool === tool);
  }

  byAction(name: string): ToolFile | undefined {
    return this.list().find((t) => t.name === name);
  }

  /** Key slots (and Nango integration ids) any tool can use. */
  keySlots(): string[] {
    return [...new Set(this.list().map((t) => t.key).filter(Boolean))];
  }

  /** Tools this user may use: keyless tools always, keyed tools only when the user has that key. */
  availableFor(hasKey: (slot: string) => boolean): ToolFile[] {
    return this.list().filter((t) => !t.needs_key || hasKey(t.key));
  }
}

const builtin = new Map<string, ToolFile>();

/** Description and schema of a built-in tool, read from its file. Used by registry.ts. */
export function builtinTool(name: string): Pick<ToolFile, "description" | "parameters"> {
  if (builtin.size === 0) {
    for (const t of new ToolCatalog().list()) if (t.kind === "builtin") builtin.set(t.name, t);
  }
  const found = builtin.get(name);
  if (!found) throw new Error(`tools/: no built-in tool file for ${name}`);
  return { description: found.description, parameters: found.parameters };
}

/** Sentence appended to the outmate_search description, built from the tools a user can use. */
export function capabilityLine(tools: ToolFile[]): string {
  const items = [...new Set(tools.map((t) => t.capability))];
  return items.length ? `Can currently use: ${items.join("; ")}.` : "";
}

// ---------------------------------------------------------------------------------------------
// Input check for http tools (a small subset of JSON schema, enough for flat tool inputs).

function checkValue(path: string, schema: Record<string, unknown>, value: unknown): void {
  const bad = (msg: string): never => {
    throw new AppError("E_VALIDATION", `${path} ${msg}`);
  };
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) bad(`must be one of: ${schema.enum.join(", ")}`);
  switch (schema.type) {
    case "string":
      if (typeof value !== "string") bad("must be a string");
      if (typeof schema.maxLength === "number" && (value as string).length > schema.maxLength) bad("is too long");
      if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value as string)) bad("has the wrong format");
      break;
    case "integer":
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) bad("must be a number");
      if (schema.type === "integer" && !Number.isInteger(value)) bad("must be a whole number");
      if (typeof schema.minimum === "number" && (value as number) < schema.minimum) bad(`must be at least ${schema.minimum}`);
      if (typeof schema.maximum === "number" && (value as number) > schema.maximum) bad(`must be at most ${schema.maximum}`);
      break;
    case "boolean":
      if (typeof value !== "boolean") bad("must be true or false");
      break;
    case "array": {
      if (!Array.isArray(value)) return bad("must be a list");
      if (typeof schema.maxItems === "number" && value.length > schema.maxItems) bad("has too many items");
      if (isRecord(schema.items)) value.forEach((v, i) => checkValue(`${path}[${i}]`, schema.items as Record<string, unknown>, v));
      break;
    }
    default:
      break;
  }
}

export function validateToolInput(tool: ToolFile, input: unknown): Record<string, unknown> {
  if (!isRecord(input)) throw new AppError("E_VALIDATION", `${tool.tool} input must be an object`);
  const props = tool.parameters.properties;
  for (const key of Object.keys(input)) {
    if (!(key in props)) throw new AppError("E_VALIDATION", `${tool.tool}: unknown input "${key}"`);
  }
  for (const key of tool.parameters.required) {
    if (input[key] === undefined) throw new AppError("E_VALIDATION", `${tool.tool}: "${key}" is required`);
  }
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    const schema = props[key];
    if (isRecord(schema)) checkValue(key, schema, value);
  }
  return input;
}

// ---------------------------------------------------------------------------------------------
// Runner for http tools.

const WHOLE = /^\{([a-z][a-z0-9_]*)\}$/;
const PLACEHOLDER = /\{([a-z][a-z0-9_]*)\}/g;

/**
 * Fill `{param}` anywhere in a value. A string that is exactly `{param}` keeps the input's own type
 * (number, list...) and disappears when the model left that input out; inside longer text it is
 * replaced as text. A list or object that only held missing inputs is dropped too.
 */
function fillValue(v: unknown, input: Record<string, unknown>): unknown {
  if (typeof v === "string") {
    const whole = WHOLE.exec(v);
    if (whole) return input[whole[1]!];
    return v.replace(PLACEHOLDER, (_, p: string) => String(input[p] ?? ""));
  }
  if (Array.isArray(v)) {
    const out = v.map((x) => fillValue(x, input)).filter((x) => x !== undefined);
    return v.length > 0 && out.length === 0 ? undefined : out;
  }
  if (isRecord(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const filled = fillValue(x, input);
      if (filled !== undefined) out[k] = filled;
    }
    return Object.keys(v).length > 0 && Object.keys(out).length === 0 ? undefined : out;
  }
  return v;
}

function fillMap(map: Record<string, unknown> | undefined, input: Record<string, unknown>): Record<string, unknown> {
  const filled = fillValue(map ?? {}, input);
  return isRecord(filled) ? filled : {};
}

export interface HttpToolDeps {
  apiKey?: string;
  /** Extra fields from the user's connection, e.g. a Salesforce instance_url. */
  meta?: Record<string, string>;
  fetchImpl?: FetchLike;
  timeoutMs: number;
  retryDelayMs?: number;
  maxChars: number;
}

/** The request line a tool would send, for tests and the probe script. The key is never included. */
export function describeHttpRequest(tool: ToolFile, rawInput: unknown, base?: string): { method: string; url: string; body?: unknown } {
  const spec = tool.request!;
  const input = validateToolInput(tool, rawInput);
  const path = spec.url.replace(PLACEHOLDER, (_, p: string) => encodeURIComponent(String(input[p] ?? "")));
  const url = new URL(spec.base_from ? `${base ?? "https://instance.invalid"}${path}` : path);
  for (const [k, v] of Object.entries(fillMap(spec.query, input))) url.searchParams.set(k, String(v));
  return { method: spec.method, url: url.href, body: spec.method === "POST" ? fillMap(spec.body, input) : undefined };
}

/** The host for a tool whose base comes from the user's connection. Only allow-listed https hosts pass. */
export function resolveBase(tool: ToolFile, meta: Record<string, string> | undefined): string {
  const spec = tool.request!.base_from!;
  const raw = meta?.[spec.field];
  if (!raw) throw new AppError("E_CONFIG", `Your ${tool.key} connection has no ${spec.field}. Reconnect it on the Connections page.`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError("E_CONFIG", `Your ${tool.key} ${spec.field} is not a valid URL.`);
  }
  const host = url.hostname.toLowerCase();
  const allowed = spec.suffixes.some((x) => host.endsWith(x));
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !allowed) {
    throw new AppError("E_CONFIG", `Your ${tool.key} ${spec.field} points somewhere this tool may not call.`);
  }
  return `https://${host}`;
}

function pick(data: unknown, path: string | undefined): unknown {
  if (!path) return data;
  let cur = data;
  for (const part of path.split(".")) {
    if (Array.isArray(cur) && /^\d+$/.test(part)) cur = cur[Number(part)];
    else cur = isRecord(cur) ? cur[part] : undefined;
  }
  return cur;
}

/** Split a saved key "first:second" at the first colon. */
function keyPart(tool: ToolFile, key: string, part: 0 | 1 | undefined): string {
  if (part === undefined) return key;
  const i = key.indexOf(":");
  if (i < 1 || i === key.length - 1) {
    throw new AppError("E_CONFIG", `The ${tool.key} key needs two values joined by a colon (first:second). Save it again on the Connections page.`);
  }
  return part === 0 ? key.slice(0, i) : key.slice(i + 1);
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

function fillKeyParts(tool: ToolFile, value: JsonLike, key: string): JsonLike {
  if (typeof value === "string") {
    return value.replace(/\{key\.([01])\}/g, (_, n: string) => keyPart(tool, key, Number(n) as 0 | 1));
  }
  if (Array.isArray(value)) return value.map((v) => fillKeyParts(tool, v, key));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillKeyParts(tool, v as JsonLike, key)]));
  return value;
}

/** Trade the saved key for a short-lived token, cached until shortly before it expires. */
async function exchangeToken(tool: ToolFile, key: string, deps: HttpToolDeps): Promise<string> {
  const ex = tool.request!.token_exchange!;
  const cacheKey = `${tool.key}:${createHash("sha256").update(key).digest("hex")}`;
  const hit = tokenCache.get(cacheKey);
  if (hit && hit.expiresAt - 60_000 > Date.now()) return hit.token;

  const res = await fetchWithRetry(
    ex.url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...tool.request!.headers },
      body: JSON.stringify(fillKeyParts(tool, ex.body, key)),
    },
    { fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs, retryDelayMs: deps.retryDelayMs },
  );
  assertUpstreamOk(res, `${tool.key} sign-in`);
  const data = await readJsonBody(res, `${tool.key} sign-in`);
  const token = pick(data, ex.token_path ?? "access_token");
  if (typeof token !== "string" || !token) throw new AppError("E_PROVIDER", `${tool.key} sign-in returned no access token`);
  const seconds = Number(pick(data, ex.expires_path ?? "expires_in"));
  tokenCache.set(cacheKey, { token, expiresAt: Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 300) * 1000 });
  return token;
}

/** Forget exchanged tokens (tests). */
export function clearTokenCache(): void {
  tokenCache.clear();
}

/** Call an http tool's endpoint with the user's key and return the JSON the model should see. */
export async function runHttpTool(tool: ToolFile, rawInput: unknown, deps: HttpToolDeps): Promise<unknown> {
  const spec = tool.request;
  if (!spec) throw new AppError("E_INTERNAL", `${tool.tool} has no request`);
  if (spec.auth && !deps.apiKey) {
    throw new AppError("E_CONFIG", `No ${tool.key} key for this user. Add it on the Connections page.`);
  }
  const base = spec.base_from ? resolveBase(tool, deps.meta) : undefined;
  const { url: href, body } = describeHttpRequest(tool, rawInput, base);
  const url = new URL(href);

  const headers: Record<string, string> = { Accept: spec.response === "text" ? "text/plain, */*" : "application/json" };
  Object.assign(headers, spec.headers);
  const key = deps.apiKey ?? "";
  const parts = spec.auth === undefined ? [] : Array.isArray(spec.auth) ? spec.auth : [spec.auth];
  let exchanged: string | undefined;
  for (const auth of parts) {
    let secret: string;
    if (auth.from === "exchange") {
      exchanged ??= await exchangeToken(tool, key, deps);
      secret = exchanged;
    } else {
      secret = keyPart(tool, key, auth.part);
    }
    if (auth.in === "bearer") headers.Authorization = `Bearer ${secret}`;
    else if (auth.in === "header") headers[auth.name!] = `${auth.prefix ?? ""}${secret}`;
    else if (auth.in === "query") url.searchParams.set(auth.name!, secret);
    else if (auth.in === "basic") {
      const pair = auth.user === undefined ? `${secret}:` : `${auth.user}:${secret}`;
      headers.Authorization = `Basic ${Buffer.from(pair).toString("base64")}`;
    }
  }

  const init: RequestInit = { method: spec.method, headers };
  if (spec.method === "POST") {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const label = tool.key || tool.tool;
  const res = await fetchWithRetry(url.href, init, {
    fetchImpl: deps.fetchImpl,
    timeoutMs: spec.timeout_ms ?? deps.timeoutMs,
    retryDelayMs: deps.retryDelayMs,
  });
  assertUpstreamOk(res, label);

  let data: unknown;
  if (spec.response === "text") {
    const { text } = await readTextCapped(res);
    data = { text };
  } else {
    data = pick(await readJsonBody(res, label), spec.result_path);
  }
  const text = JSON.stringify(data ?? null);
  const cut = truncate(text, deps.maxChars);
  return cut.truncated ? { truncated: true, partial_json: cut.text } : data;
}
