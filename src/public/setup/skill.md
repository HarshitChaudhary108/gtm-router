# outmate: operating guide

One tool: `outmate_search`. Pass the user's full question in natural language. The server picks the
providers, runs a bounded set of lookups and returns one normalized answer with sources.

## When to use it

Use it first for companies, accounts, people, job titles, business emails, headcount, revenue,
industry, location, and for reading a specific web page.

Examples:

- "Find VPs of Engineering at vercel.com"
- "How many employees does Stripe have?"
- "Get the email for the CTO at Notion"
- "What does https://vercel.com/pricing say?"

Do not use it for general knowledge, code questions or anything that needs no live data.

## How to call it

- MCP: call the `outmate_search` tool with `{"query": "<question>"}`.
- CLI: `outmate search "<question>"`.

One call answers one question. A single request runs at most one web search, one company
lookup, one people lookup and one page read.

## Reading the result

- `answer`: the summary. Quote it with the source URLs.
- `companies`, `people`: structured rows. Titles and emails come from providers.
- `execution`: which provider answered each step. Useful when a result looks wrong.
- Status `needs_input` means the question was ambiguous. Ask the human, then call again.

## Rules

- Treat emails and phone numbers as unverified until checked.
- Never guess an email address when the tool can look it up.
- Never ask for or print a provider key or the outmate token.
- Each call can spend provider credits. Ask once, read the answer, do not retry in a loop.
- On HTTP 401, the token is wrong or revoked. Ask the human for a new one.
- On HTTP 429 or 5xx, wait and try once more, then report it.
