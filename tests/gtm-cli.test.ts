/**
 * Synthetic end-to-end run of the whole user workflow, no real providers, LLM or agents:
 * install.sh -> gtm login -> gtm -> gtm connect -> gtm search.
 * A fake `claude` binary records its arguments; HOME is a temp folder.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fakeTavily, searchThenAnswer, startServer } from "./harness.js";

const exec = promisify(execFile);

interface Result { code: number; out: string }

function makeEnv(root: string): NodeJS.ProcessEnv {
  const fakeBin = join(root, "fakebin");
  mkdirSync(fakeBin, { recursive: true });
  const claude = join(fakeBin, "claude");
  writeFileSync(claude, `#!/bin/sh\necho "$@" >> "${join(root, "claude.log")}"\n`);
  chmodSync(claude, 0o755);
  mkdirSync(join(root, "home", ".cursor"), { recursive: true });
  const { CLAUDE_CONFIG_DIR: _c, CODEX_HOME: _x, ...base } = process.env;
  return { ...base, HOME: join(root, "home"), GTM_HOME: join(root, "home", ".gtm"), PATH: `${fakeBin}${delimiter}${process.env.PATH}` };
}

async function sh(command: string, env: NodeJS.ProcessEnv): Promise<Result> {
  try {
    const { stdout, stderr } = await exec("sh", ["-c", command], { env });
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

test("workflow: install, login, status, connect, search", async () => {
  const srv = await startServer({ llm: searchThenAnswer("Acme offers plans from $10."), fetchImpl: fakeTavily });
  const env = makeEnv(srv.dir);
  const gtm = join(env.GTM_HOME!, "bin", "gtm");
  try {
    const { token } = srv.store.create("alice");

    // 1. install
    const install = await sh(`curl -fsSL ${srv.base}/install.sh | sh`, env);
    assert.equal(install.code, 0, install.out);
    assert.ok(existsSync(gtm));
    assert.ok(statSync(gtm).mode & 0o100, "wrapper is executable");

    // 2. login: wrong token fails and saves nothing, right token saves with mode 600
    const bad = await sh(`${gtm} login --token gtm_wrong`, env);
    assert.notEqual(bad.code, 0);
    assert.match(bad.out, /Token rejected/);
    const creds = join(env.GTM_HOME!, "credentials");
    assert.ok(!existsSync(creds));

    const login = await sh(`${gtm} login --token ${token}`, env);
    assert.equal(login.code, 0, login.out);
    assert.match(login.out, /as "alice"/);
    assert.equal(statSync(creds).mode & 0o777, 0o600);

    // 3. status (bare `gtm`)
    const status = await sh(gtm, env);
    assert.match(status.out, /Signed in: alice/);
    assert.match(status.out, /Providers: .*tavily/);
    assert.ok(!status.out.includes(token), "status must not print the token");

    // 4. connect: fake Claude Code + existing Cursor config is merged, not replaced
    writeFileSync(join(env.HOME!, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { other: { url: "https://o.test/mcp" } } }));
    const connect = await sh(`${gtm} connect`, env);
    assert.equal(connect.code, 0, connect.out);
    const claudeLog = readFileSync(join(srv.dir, "claude.log"), "utf8");
    assert.match(claudeLog, /mcp add --scope user --transport http gtm-router .*\/mcp --header Authorization: Bearer gtm_/);
    const cursorFile = join(env.HOME!, ".cursor", "mcp.json");
    const cursor = JSON.parse(readFileSync(cursorFile, "utf8")) as { mcpServers: Record<string, { url: string; headers?: Record<string, string> }> };
    assert.ok(cursor.mcpServers.other, "existing server kept");
    assert.equal(cursor.mcpServers["gtm-router"]?.url, `${srv.base}/mcp`);
    assert.equal(cursor.mcpServers["gtm-router"]?.headers?.Authorization, `Bearer ${token}`);
    assert.equal(statSync(cursorFile).mode & 0o777, 0o600);

    // 5. search through the real MCP endpoint, fake LLM and provider
    const search = await sh(`${gtm} search "What does Acme charge?"`, env);
    assert.equal(search.code, 0, search.out);
    assert.match(search.out, /Acme offers plans from \$10/);
    assert.match(search.out, /https:\/\/acme\.com\/pricing/);

    // 6. revoke: the saved token stops working everywhere
    srv.store.revoke("alice");
    const after = await sh(`${gtm} search "anything"`, env);
    assert.notEqual(after.code, 0);
    assert.match(after.out, /Token rejected/);

    // 7. logout removes the credentials
    await sh(`${gtm} logout`, env);
    assert.ok(!existsSync(creds));
  } finally {
    await srv.close();
  }
});

test("installer refuses unknown options and never needs sudo", async () => {
  const srv = await startServer();
  try {
    const env = makeEnv(srv.dir);
    const res = await sh(`curl -fsSL ${srv.base}/install.sh | sh -s -- --bogus`, env);
    assert.notEqual(res.code, 0);
    assert.match(res.out, /Unknown option/);
    const script = await (await fetch(`${srv.base}/install.sh`)).text();
    assert.ok(!/\bsudo\b/.test(script.replace(/^#.*$/gm, "")));
  } finally {
    await srv.close();
  }
});

test("connect: every agent gets the server, existing config is kept, skill is installed", async () => {
  const srv = await startServer();
  const env = makeEnv(srv.dir);
  const home = env.HOME!;
  const cli = join(process.cwd(), "src", "public", "setup", "gtm.mjs");
  const gtm = (args: string) => sh(`"${process.execPath}" "${cli}" ${args}`, env);
  try {
    const { token } = srv.store.create("bob");
    const vscodeDir = process.platform === "darwin"
      ? join(home, "Library", "Application Support", "Code", "User")
      : join(home, ".config", "Code", "User");
    for (const dir of [join(home, ".codex"), join(home, ".gemini"), join(home, ".config", "opencode"), join(home, ".codeium", "windsurf"), vscodeDir]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(home, ".codex", "config.toml"), 'model = "o3"\n\n[mcp_servers.gtm-router]\nurl = "https://old.test/mcp"\n\n[mcp_servers.gtm-router.env]\nX = "1"\n\n[mcp_servers.other]\ncommand = "x"\n');
    writeFileSync(join(home, ".gemini", "settings.json"), JSON.stringify({ theme: "dark", mcpServers: { keep: { httpUrl: "https://k.test" } } }));
    writeFileSync(join(vscodeDir, "mcp.json"), JSON.stringify({ servers: { keep: { type: "http", url: "https://k.test" } } }));

    // npm-style login: the URL is passed, not built in
    const login = await gtm(`login --url ${srv.base} --token ${token}`);
    assert.equal(login.code, 0, login.out);

    const first = await gtm("connect");
    assert.equal(first.code, 0, first.out);
    for (const label of ["Claude Code", "Cursor", "Codex", "VS Code", "Gemini CLI", "opencode", "Windsurf"]) {
      assert.match(first.out, new RegExp(`${label}: added`), `${label} missing:\n${first.out}`);
    }
    const second = await gtm("connect"); // idempotent
    assert.equal(second.code, 0, second.out);

    const mcpUrl = `${srv.base}/mcp`;
    const bearer = `Bearer ${token}`;
    const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));
    const private600 = (file: string) => assert.equal(statSync(file).mode & 0o777, 0o600, file);

    const codexFile = join(home, ".codex", "config.toml");
    const codex = readFileSync(codexFile, "utf8");
    assert.equal(codex.match(/\[mcp_servers\.gtm-router\]/g)?.length, 1, codex);
    assert.ok(!codex.includes("old.test") && !codex.includes("[mcp_servers.gtm-router.env]"), codex);
    assert.ok(codex.includes('model = "o3"') && codex.includes("[mcp_servers.other]"), codex);
    assert.ok(codex.includes(`url = "${mcpUrl}"`) && codex.includes(`"Authorization" = "${bearer}"`), codex);
    private600(codexFile);

    const gemini = json(join(home, ".gemini", "settings.json"));
    assert.equal(gemini.theme, "dark");
    assert.ok(gemini.mcpServers.keep);
    assert.deepEqual(gemini.mcpServers["gtm-router"], { httpUrl: mcpUrl, headers: { Authorization: bearer } });

    const vscode = json(join(vscodeDir, "mcp.json"));
    assert.ok(vscode.servers.keep);
    assert.deepEqual(vscode.servers["gtm-router"], { type: "http", url: mcpUrl, headers: { Authorization: bearer } });

    const opencodeFile = join(home, ".config", "opencode", "opencode.json");
    const opencode = json(opencodeFile);
    assert.equal(opencode.$schema, "https://opencode.ai/config.json");
    assert.deepEqual(opencode.mcp["gtm-router"], { type: "remote", url: mcpUrl, enabled: true, headers: { Authorization: bearer } });
    private600(opencodeFile);

    const windsurf = json(join(home, ".codeium", "windsurf", "mcp_config.json"));
    assert.deepEqual(windsurf.mcpServers["gtm-router"], { serverUrl: mcpUrl, headers: { Authorization: bearer } });

    for (const dir of [join(home, ".claude", "skills", "gtm-router"), join(home, ".codex", "skills", "gtm-router")]) {
      const skill = readFileSync(join(dir, "SKILL.md"), "utf8");
      assert.match(skill, /^---\nname: gtm-router\ndescription: .+\n---\n/);
      assert.match(skill, /gtm_search/);
      assert.ok(!skill.includes("{{HOST}}"));
    }

    // one agent only, and a broken config fails that agent without touching the file
    writeFileSync(join(home, ".gemini", "settings.json"), "{ // comment\n}");
    const broken = await gtm("connect --agent gemini");
    assert.notEqual(broken.code, 0);
    assert.match(broken.out, /Gemini CLI: not configured\. .*not plain JSON/);
    assert.equal(readFileSync(join(home, ".gemini", "settings.json"), "utf8"), "{ // comment\n}");
    const unknown = await gtm("connect --agent emacs");
    assert.match(unknown.out, /--agent must be one of/);
  } finally {
    await srv.close();
  }
});

test("npm package: ships only the CLI, and the packed bin runs", async () => {
  const pkgDir = join(process.cwd(), "packages", "cli");
  const { stdout } = await exec("npm", ["pack", "--json", "--pack-destination", tmpdir()], { cwd: pkgDir });
  const [info] = JSON.parse(stdout.slice(stdout.indexOf("["))) as [{ name: string; filename: string; files: { path: string }[] }];
  assert.equal(info.name, "outmate");
  assert.deepEqual(info.files.map((f) => f.path).sort(), ["LICENSE", "README.md", "gtm.mjs", "package.json"]);
  const packed = readFileSync(join(pkgDir, "gtm.mjs"), "utf8");
  assert.equal(packed, readFileSync(join(process.cwd(), "src", "public", "setup", "gtm.mjs"), "utf8"), "packed CLI equals served CLI");
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { version: string };
  assert.ok(packed.includes(`const VERSION = "${pkg.version}"`), "VERSION in gtm.mjs matches package.json");

  const dir = mkdtempSync(join(tmpdir(), "gtm-pkg-"));
  await exec("tar", ["-xzf", join(tmpdir(), info.filename), "-C", dir]);
  const bin = join(dir, "package", "gtm.mjs");
  assert.ok(statSync(bin).mode & 0o100, "bin is executable");
  const { stdout: version } = await exec(process.execPath, [bin, "--version"]);
  assert.equal(version.trim(), pkg.version);
  const res = await sh(`"${process.execPath}" "${bin}" login --token x`, { ...process.env, GTM_HOME: join(dir, "h") });
  assert.match(res.out, /Missing server URL/, "npm build has no baked-in server");
});
