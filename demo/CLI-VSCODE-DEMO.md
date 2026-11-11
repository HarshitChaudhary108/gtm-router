# Demo 2: Claude Code CLI (terminal) and VS Code

Your tech lead wants to see the same flow in the Claude Code CLI in a plain terminal, then in the
Claude Code extension in VS Code.

## Why both work from one setup

A plain terminal `claude` and the VS Code extension read the same config, `~/.claude.json`.
`outmate connect` adds outmate there at user scope, so after one setup in the terminal, VS Code
already has the `outmate_search` tool. Showing that is the point of part B.

(The first video was recorded in the Claude desktop app, which uses a different profile. That's
why `~/.claude.json` has no outmate yet. The terminal setup below adds it.)

## Search budget

The free Gemini key allows about 7 searches a day. This recording uses 3. Don't run extra test
searches on recording day.

## Before recording

1. Terminal 1: `cd ~/Documents/Coding/gtm-router && npm run mcp`
2. Terminal 2: `ngrok http 3333 --host-header=rewrite --url https://goldsmith-panther-exporter.ngrok-free.dev`
3. Open the setup card in the browser.
4. Use a large terminal font, and turn notifications off.

## Part A: Claude Code CLI in a terminal (about 4 min)

1. Open a new Terminal window in an empty folder (`mkdir -p ~/demo && cd ~/demo`) and run `claude`.
2. Copy the setup line from the card and paste it. Say: "Same one line, this time in the terminal CLI."
3. When Claude asks for the token, copy it from the card and paste it.
4. Claude runs install (it will likely use `npx -y outmate`), `outmate login`, then `outmate connect`.
   Point at the line `Claude Code: added (user scope), skill installed`. **Search 1:** its test search.
5. Type `/exit`, then run `claude` again. Type `/mcp` and show `outmate · connected`.
6. Ask: `Find engineering leaders at vercel.com`. Point out that Claude calls the `outmate_search`
   tool itself now, with no CLI command. **Search 2.**

## Part B: Claude Code in VS Code (about 2 min)

1. Open VS Code, then open the Claude Code panel (the Claude icon in the editor toolbar, or Cmd+Esc).
2. Start a new conversation and type `/mcp`. outmate is already connected, with no setup in VS Code.
   Say: "The extension reads the same config as the terminal CLI."
3. Ask: `How many employees does Linear have, and where are they based?` **Search 3.**

## After recording

- Revoke the demo token if the card or chat was shared: `npm run token -- revoke founder-demo`
- Stop ngrok when you're done.
