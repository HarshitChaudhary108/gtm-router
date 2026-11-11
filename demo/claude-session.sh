#!/bin/sh
# Fresh headless Claude Code session: shows the outmate MCP server is loaded and outmate_search gets called.
# Writes the raw stream to demo/claude-session.jsonl and prints a short summary.
set -eu
OUT="$(cd "$(dirname "$0")" && pwd)/claude-session.jsonl"
cd "$(mktemp -d)"
claude -p "Use the outmate_search tool to find engineering leaders at vercel.com. Call it exactly once, then report in two sentences what it returned." \
  --allowedTools "mcp__outmate__outmate_search" --output-format stream-json --verbose > "$OUT" 2>&1 || true
node -e '
const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean);
for (const l of lines) {
  let m; try { m = JSON.parse(l); } catch { continue; }
  if (m.type === "system" && m.subtype === "init") console.log("MCP servers:", JSON.stringify(m.mcp_servers));
  for (const c of m.message?.content || []) {
    if (c.type === "tool_use") console.log("TOOL CALL:  ", c.name, JSON.stringify(c.input));
    if (c.type === "tool_result") console.log("TOOL RESULT:", JSON.stringify(c.content).slice(0, 300));
  }
  if (m.type === "result") console.log("FINAL:      ", m.result);
}' "$OUT"
echo "DEMO-SESSION-DONE"
