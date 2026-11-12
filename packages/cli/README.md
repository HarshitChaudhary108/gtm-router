# outmate

The `outmate` command connects your coding agent to a outmate server, which gives the agent one
MCP tool, `outmate_search`, for company, people, business email and web research. Provider keys stay
on the server; you only hold a outmate token from your admin.

## Quick start

Tell your agent:

```
set up outmate — https://<your-server>/llms.txt
```

Or by hand:

```bash
npm i -g outmate
outmate login --url https://<your-server> --token <token>
outmate connect
outmate
outmate search "Find engineering leaders at vercel.com"
```

No global install? Use `npx -y outmate` in place of `outmate`.

## Commands

| Command | What it does |
|---|---|
| `outmate login --url <server> --token <token>` | Checks the token against the server and saves it (readable only by you) |
| `outmate connect [--agent <name>]` | Adds the MCP server to every agent it finds, and the skill for Claude Code and Codex |
| `outmate` | Shows who is signed in and which providers are on |
| `outmate search "<question>"` | Runs `outmate_search` from the terminal |
| `outmate logout` | Deletes the saved token |

Agents: `claude`, `cursor`, `codex`, `vscode`, `gemini`, `opencode`, `windsurf`.

Node.js 18 or newer. One file, no dependencies. Update with `npm update -g outmate`.
