export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export interface Rec {
  id: string;
  properties: Record<string, string>;
}

/** A tiny HubSpot: contacts in memory, search, create, update and notes. Records every call. */
export function fakeHubspot(seed: Rec[], opts: { forbidWrites?: boolean; failNotes?: boolean; createStatus?: number } = {}) {
  const records: Rec[] = seed.map((r) => ({ id: r.id, properties: { ...r.properties } }));
  const calls: Array<{ method: string; path: string; body: any; auth: string | null }> = [];
  let nextId = 100;
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    if (u.host !== "api.hubapi.com") return json({ error: "unexpected host" }, 500);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const auth = (init?.headers as Record<string, string>)?.Authorization ?? null;
    calls.push({ method, path: u.pathname, body, auth });

    const isSearch = u.pathname === "/crm/v3/objects/contacts/search";
    if (method !== "GET" && !u.pathname.endsWith("/search") && opts.forbidWrites) return json({ message: "forbidden" }, 403);

    if (isSearch) {
      let found: Rec[];
      if (body.filterGroups) {
        const value = body.filterGroups[0].filters[0].value as string;
        found = records.filter((r) => r.properties.email === value);
      } else {
        const q = String(body.query).toLowerCase();
        found = records.filter((r) => `${r.properties.firstname ?? ""} ${r.properties.lastname ?? ""}`.toLowerCase().includes(q));
      }
      return json({ results: found.map((r) => ({ id: r.id, properties: r.properties })) });
    }
    if (u.pathname === "/crm/v3/objects/companies/search") return json({ results: [] });
    if (u.pathname === "/crm/v3/objects/notes") return opts.failNotes ? json({ message: "no" }, 400) : json({ id: "n1" }, 201);
    if (u.pathname === "/crm/v3/objects/contacts" && method === "POST") {
      if (opts.createStatus) return json({ message: "boom" }, opts.createStatus);
      if (records.some((r) => r.properties.email && r.properties.email === body.properties.email)) return json({ message: "exists" }, 409);
      const rec = { id: String(nextId++), properties: { ...body.properties } };
      records.push(rec);
      return json({ id: rec.id, properties: rec.properties }, 201);
    }
    const one = /^\/crm\/v3\/objects\/contacts\/(\d+)$/.exec(u.pathname);
    if (one) {
      const rec = records.find((r) => r.id === one[1]);
      if (!rec) return json({ message: "not found" }, 404);
      if (method === "DELETE") {
        records.splice(records.indexOf(rec), 1);
        return new Response(null, { status: 204 });
      }
      if (method === "PATCH") Object.assign(rec.properties, body.properties);
      return json({ id: rec.id, properties: rec.properties });
    }
    return json({ error: "unhandled" }, 404);
  };
  const writes = () => calls.filter((c) => c.method !== "GET" && !c.path.endsWith("/search"));
  return { fetchImpl, calls, records, writes };
}

