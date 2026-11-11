import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "./errors.js";
import { fetchWithRetry, readJsonBody, assertUpstreamOk, type FetchLike } from "./http.js";
import { isRecord, truncate } from "./util.js";

export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
}

/** How an `http` tool calls its provider. Host and scheme are fixed in the file, never templated. */
export interface HttpRequestSpec {
  method: "GET" | "POST";
  /** https URL. `{param}` may appear in the path only. */
  url: string;
  /** Query parameters. A value of exactly `{param}` is dropped when the model leaves that input out. */
  query?: Record<string, string>;
  /** JSON body, same templating as query. */
  body?: Record<string, string>;
  /** Where the user's key goes. */
  auth: { in: "header" | "query" | "bearer"; name?: string };
  /** Dot path into the JSON response to hand to the model, e.g. "data". */
  result_path?: string;
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
  kind: "builtin" | "http";
  /** Key slot. Also the Nango integration id the user's key is saved under. */
  key: string;
  /** When true the tool is only offered to a user who has a key for `key`. */
  needs_key: boolean;
  /** Short phrase used to build the outmate_search description. */
  capability: string;
  description: string;
  parameters: JsonSchemaObject;
  request?: HttpRequestSpec;
}

const TOOL_RE = /^[a-z][a-z0-9_]{0,47}$/;
const KEY_RE = /^[a-z][a-z0-9_-]{0,31}$/;

function fail(file: string, message: string): never {
  throw new Error(`${file}: ${message}`);
}

/** Check one parsed tool file. Throws a plain Error naming the file and the problem. */
export function checkToolFile(raw: unknown, file = "tool"): ToolFile {
  if (!isRecord(raw)) fail(file, "must be a JSON object");
  const { name, tool, kind, key, needs_key, capability, description, parameters, request } = raw;
  if (typeof name !== "string" || !name) fail(file, "name is required");
  if (typeof tool !== "string" || !TOOL_RE.test(tool)) fail(file, "tool must be snake_case, up to 48 characters");
  if (kind !== "builtin" && kind !== "http") fail(file, 'kind must be "builtin" or "http"');
  if (typeof key !== "string" || !KEY_RE.test(key)) fail(file, "key must be a lowercase id such as hunter");
  if (typeof needs_key !== "boolean") fail(file, "needs_key must be true or false");
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
    let url: URL;
    try {
      url = new URL(request.url.replace(/\{[a-z_]+\}/g, "x"));
    } catch {
      fail(file, "request.url is not a valid URL");
    }
    if (url.protocol !== "https:") fail(file, "request.url must be https");
    const host = request.url.slice("https://".length).split("/")[0] ?? "";
    if (host.includes("{")) fail(file, "request.url host must be fixed, not templated");
    if (!isRecord(request.auth) || !["header", "query", "bearer"].includes(String(request.auth.in))) {
      fail(file, 'request.auth.in must be "header", "query" or "bearer"');
    }
    if (request.auth.in !== "bearer" && typeof request.auth.name !== "string") {
      fail(file, "request.auth.name is required for header and query auth");
    }
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
    return [...new Set(this.list().map((t) => t.key))];
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

const WHOLE = /^\{([a-z_]+)\}$/;

function fillMap(map: Record<string, string> | undefined, input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(map ?? {})) {
    const whole = WHOLE.exec(v);
    if (whole) {
      const value = input[whole[1]!];
      if (value !== undefined) out[k] = value;
    } else {
      out[k] = v.replace(/\{([a-z_]+)\}/g, (_, p: string) => String(input[p] ?? ""));
    }
  }
  return out;
}

export interface HttpToolDeps {
  apiKey?: string;
  fetchImpl?: FetchLike;
  timeoutMs: number;
  retryDelayMs?: number;
  maxChars: number;
}

/** Call an http tool's endpoint with the user's key and return the JSON the model should see. */
export async function runHttpTool(tool: ToolFile, rawInput: unknown, deps: HttpToolDeps): Promise<unknown> {
  const spec = tool.request;
  if (!spec) throw new AppError("E_INTERNAL", `${tool.tool} has no request`);
  if (!deps.apiKey) throw new AppError("E_CONFIG", `No ${tool.key} key for this user. Add it on the Connections page.`);
  const input = validateToolInput(tool, rawInput);

  const path = spec.url.replace(/\{([a-z_]+)\}/g, (_, p: string) => encodeURIComponent(String(input[p] ?? "")));
  const url = new URL(path);
  for (const [k, v] of Object.entries(fillMap(spec.query, input))) url.searchParams.set(k, String(v));

  const headers: Record<string, string> = { Accept: "application/json" };
  if (spec.auth.in === "bearer") headers.Authorization = `Bearer ${deps.apiKey}`;
  else if (spec.auth.in === "header") headers[spec.auth.name!] = deps.apiKey;
  else url.searchParams.set(spec.auth.name!, deps.apiKey);

  const init: RequestInit = { method: spec.method, headers };
  if (spec.method === "POST") {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(fillMap(spec.body, input));
  }

  const res = await fetchWithRetry(url.href, init, {
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.timeoutMs,
    retryDelayMs: deps.retryDelayMs,
  });
  assertUpstreamOk(res, tool.key);
  let data = await readJsonBody(res, tool.key);

  if (spec.result_path) {
    for (const part of spec.result_path.split(".")) {
      data = isRecord(data) ? data[part] : undefined;
    }
  }
  const text = JSON.stringify(data ?? null);
  const cut = truncate(text, deps.maxChars);
  return cut.truncated ? { truncated: true, partial_json: cut.text } : data;
}
