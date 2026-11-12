# Tools and per-user keys

`outmate_search` is the only tool an agent sees. Behind it, the router picks from a folder of tool
files and calls the providers with the **user's own keys**.

## Tool files (`tools/*.json`)

One file per tool. The server reloads the folder whenever a file is added, edited or removed, so
**adding a tool needs no restart and no code**. A broken file is skipped and logged.

| Field | Meaning |
|---|---|
| `name` | Unique action name, e.g. `custom.hunter_email_count` |
| `tool` | The name the router's model sees (snake_case) |
| `kind` | `builtin` (code in `src/registry.ts`), `http` (fully described by `request`) or `internal` (a named handler in `src/writeback.ts`, set with `handler`) |
| `key` | Provider id. Also the Nango integration id the user's key is saved under. Leave out for public APIs |
| `category` | Group heading on the Connections page |
| `needs_key` | `true`: only offered to users who have a key for `key`. Public (no `auth`) tools are `false` |
| `capability` | Short phrase added to the `outmate_search` description |
| `description`, `parameters` | What the model reads: when to use it, and its JSON-schema inputs |
| `order` | Optional position in the model's tool list |
| `request` | `http` tools only: `method`, `url`, `query`, `body`, `headers`, `auth`, `response`, `result_path`, `timeout_ms` |

### Add a tool in three steps

1. In Nango, create an API-key integration whose id equals the file's `key` (skip if it exists).
2. Copy `tools/hunter_email_count.json`, change `name`, `tool`, `key`, `capability`, `description`,
   `parameters` and `request`.
3. Done. The next `outmate_search` call sees it, and its description lists the new capability.
   Each user adds their key for that provider on `/connections`.

`request.url` must be https with a fixed host. `{param}` may appear in the path and anywhere inside
`query` / `body` (bodies can be nested objects and lists). A value that is exactly `{param}` keeps
the input's type and is dropped when the model leaves it out; every `{param}` must be a declared
input or the file is skipped. `auth.in` is one of:

| `auth.in` | Sends |
|---|---|
| `bearer` | `Authorization: Bearer <key>` |
| `header` | `<name>: <prefix><key>` (`prefix` e.g. `"Token "`) |
| `query` | `?<name>=<key>` |
| `basic` | `Authorization: Basic`, key as the user name; or `user` set to a fixed name (`""` for an empty one) with the key as password |

`auth` can also be a list (several headers or parameters), and each part can use `part` (see below)
or `from: "exchange"`.

`headers` adds fixed headers, `response: "text"` returns plain text or markdown, `result_path`
walks dots and list positions (`data.items.0`), and `timeout_ms` (max 60000) is for slow providers.
Leave `auth` out for a public API. The user's key is attached by the server and never appears in a
URL we log or in a response.

### Providers included

30 tools in `tools/`, grouped on the Connections page by the categories of the integrations sheet:

| Category | Tools |
|---|---|
| Web Search, Crawling & Research | `web_search` (Tavily, Apify, Parallel, You.com, Linkup, Firecrawl, Serper), `read_url` (Jina, Firecrawl, Browserbase), `exa_search`, `exa_find_similar` |
| People & Contact Data | `search_people` (MoltSets), `apollo_people`, `hunter_domain`, `hunter_email`, `hunter_email_count`, `prospeo_enrich_person`, `findymail_find` |
| Company, Firmographic & Funding | `search_companies` (MoltSets), `apollo_companies`, `ocean_lookalike`, `crustdata_company`, `dealroom_match_company`, `dealroom_company`, `dealroom_funding_rounds` |
| Buying Signals | `builtwith_domain`, `predictleads_job_openings`, `predictleads_news_events`, `predictleads_financing_events` |
| Email & Phone Verification | `kickbox_verify`, `debounce_verify`, `findymail_verify` |
| CRM | `hubspot_search_contacts`, `hubspot_search_companies`, `hubspot_propose_contacts` (write, needs approval), `salesforce_search_accounts`, `salesforce_search_contacts` |

All are read-only lookups except the HubSpot proposal, which still writes nothing until the user
approves. Without Nango, a provider is switched on for everyone by setting `<KEY>_API_KEY` in `.env`
(for example `EXA_API_KEY`, `HUBSPOT_API_KEY`).

Check that the requests reach their providers without any real key:

```bash
npx tsx scripts/probe-tools.ts            # every http tool, fake key
npx tsx scripts/probe-tools.ts exa hubspot # only these providers
```

`REACHED, key refused` (401/403) means host, path and key placement are right. It does not prove
the request body; that needs a real key.

## Per-user keys (Nango)

Set `NANGO_SECRET_KEY` (and `NANGO_HOST` for a self-hosted Nango). Then:

- Users open `https://<host>/connections`, paste their outmate token, and press **Connect** next to
  a provider. Nango's Connect screen takes the key; it never passes through this server.
- The connection is linked to the user by the `end_user_id` tag (the user's token name).
- On each request the server finds the caller's connections, reads their keys, and uses them. The
  keys are cached in memory for 60 seconds and redacted from every response.
- A user's own key wins. The server's `.env` keys are only a fallback, and only while
  `OUTMATE_SHARED_KEYS` is not `false`. If Nango is unreachable the fallback is used.
- Keyed tools are offered only when the user has that key, and the `outmate_search` description is
  built per user from the tools they can use.

Without `NANGO_SECRET_KEY` everything works as before with the shared keys, and `/connections`
shows each provider's status without Connect buttons.

| Route | Purpose |
|---|---|
| `GET /connections` | The page (static) |
| `GET /connections/api/state` | Each provider: `own`, `shared` or `none` (Bearer token) |
| `POST /connections/api/session` | Start a Nango Connect session for one provider |
| `POST /connections/api/refresh` | Forget cached keys after a connect |

## HubSpot write-back (propose, then approve)

Reading HubSpot uses the `hubspot` slot (`hubspot_search_contacts`, `hubspot_search_companies`).
Writing is a separate slot, `hubspot-write`, so a read-only user can never write: connect HubSpot
under that id in Nango (the login needs contacts read **and** write), or set `HUBSPOT_WRITE_API_KEY`
for a single-company setup. Only users with that connection get the tool, and for them
`outmate_search` is no longer marked read-only, so the agent's client asks before running it.

```text
"Add the missing leaders to HubSpot"
  router  -> hubspot_propose_contacts      reads HubSpot, stores a proposal, WRITES NOTHING
  server  -> shows the proposal            written by the server from the stored changes
  user    -> "yes"
  agent   -> outmate_search "apply p_xxxxxxxxxx"     not routed through the model
  server  -> writes exactly the stored changes, then adds a note to each record
```

- A proposal lists each contact as **create**, **fill blanks** (`(empty) → value`) or **skip** with
  the reason (already complete, several matches, same name with another email). Contacts are
  matched by email, then by first and last name (and company, when both sides have one).
- Existing values are never overwritten. At approval time each record is read again, so a value
  added in HubSpot after the proposal is left alone.
- A proposal belongs to one user, can be applied once, and expires after 15 minutes. Only the exact
  query `apply <id>` (optionally after "yes") is an approval.
- Writes are not retried (a retry after a timeout could create a contact twice). If HubSpot refuses
  every write, for example for lack of write access, nothing is written and the proposal stays
  valid so it can be retried after the login is fixed.
- Writable fields: first name, last name, email, job title, company, phone. Up to 10 contacts per
  proposal.
- Proposals are held in memory: they are lost on restart and need a single server process.

Checked against HubSpot's docs: create and update contacts, and the note body with association
type 202 (note to contact). **Not yet tested against a real HubSpot account:** the search request
shape, the status HubSpot returns for a duplicate email, and the exact scopes the login needs.

## Providers that need more than one credential

Nango's API-key form has one field, so a second credential is saved in the same box, joined by a
colon. Three providers work this way or need more than a key:

| Provider | What the user saves | What outmate sends |
|---|---|---|
| PredictLeads | `api_key:api_token` | `X-Api-Key` and `X-Api-Token` headers (`auth.part` 0 and 1) |
| Dealroom | `client_id:client_secret` | First trades them for a one-hour token at `accounts.dealroom.co` (`token_exchange`, cached until a minute before it expires), then sends `Authorization: Bearer <token>` and `X-Client-Id` |
| Salesforce | Nango OAuth connection with the integration id `salesforce` | The access token as a bearer token, to the user's own instance. The host comes from the connection's `instance_url` (`base_from`) |

- A key saved without the colon fails with a message that says how to save it again. Both halves
  are redacted from every response.
- `base_from` only accepts an https host ending in one of the file's `suffixes` (Salesforce:
  `.salesforce.com`, `.force.com`), with no user name, no unusual port and no look-alike domain.
- The Salesforce tools take a name that is checked against a pattern (letters, digits, space and
  `.&,-`), so a model-written search term cannot change the query. They only read.
- Without Nango: `PREDICTLEADS_API_KEY=key:token`, `DEALROOM_API_KEY=id:secret`, and
  `SALESFORCE_API_KEY=<access token>` with `SALESFORCE_INSTANCE_URL=https://yourorg.my.salesforce.com`
  (a Salesforce token expires after about two hours, so Nango is the practical way).
- The Connections page shows a help line under each of these providers (`key_help` in the file).

Checked: PredictLeads' paths answer with a 401 for a fake key where an invented path answers 404;
Dealroom's token endpoint refuses fake credentials; the request shapes follow Dealroom's and
Nango's documentation. **Not tested with real credentials:** any of the three. Dealroom's API host
sits behind a Cloudflare check that a fake token cannot get past, so its paths rest on the
documentation alone. Nango's `connection_config.instance_url` is documented but not yet seen in a
real response.

## Benchmarking providers

`scripts/bench.ts` measures the providers whose keys are in `.env`: reliability, latency (first call,
median, 95th percentile), a rough quality score and an estimated cost.

```bash
npx tsx scripts/bench.ts --dry                  # which providers would run, which keys are missing
npx tsx scripts/bench.ts                        # run every provider that has a key
npx tsx scripts/bench.ts --only exa,hunter --runs 3 --delay 1500
```

- It never calls a provider without a key, makes at most `--max-calls` calls per provider
  (default 8), waits `--delay` ms between calls, and never prints or stores a key.
- Quality is a simple check on well-known facts (for example that Stripe was founded by the
  Collisons). It shows whether a provider gets easy questions right, not how it does on your hard
  ones. Verification providers are checked on two known-bad addresses. CRM providers are timed only.
- Latency includes the one automatic retry on a 429 or 5xx, so a rate-limited call shows up as slow.
- Prices and free allowances in the script are from the providers' public pages (2026-11-12); some
  sources disagree, so check a provider's own pricing page before relying on a number.
- Results go to `data/bench-results.json` (git-ignored).

## Live check of HubSpot (read and write-back)

Use a free HubSpot **developer test account**, never a real CRM. Create a private app in it with
contacts read and write and companies read (add the notes scope if HubSpot lists one), and put its
token in `.env` as `HUBSPOT_WRITE_API_KEY`.

```bash
npx tsx scripts/hubspot-live-check.ts              # shows what it would do, changes nothing
npx tsx scripts/hubspot-live-check.ts --yes-write  # runs it, then archives its test contact
```

It searches companies and contacts, proposes a new contact `outmate-check-<id>@example.com` and
confirms nothing was written, approves it (the contact and its note appear), fills a blank job title,
confirms a different title is never overwritten, and archives the contact. Each step prints its
timing. If HubSpot refuses a step, the message includes HubSpot's own text, which names the missing
scope. This is the test that settles what the unit tests could only fake: the search request shape,
the notes call, and which scopes are really needed.

Salesforce can be timed the same way for a quick one-off: put a short-lived access token and the
org address in `.env` (`SALESFORCE_API_KEY`, `SALESFORCE_INSTANCE_URL`) and run
`npx tsx scripts/bench.ts --only salesforce`. The token expires after about two hours, so a lasting
setup goes through Nango.
