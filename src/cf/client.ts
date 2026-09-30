// Minimal typed client for the Cloudflare APIs Spikeward uses: zones, analytics, lists, rulesets.
const API = "https://api.cloudflare.com/client/v4";

export class CfError extends Error {
  constructor(message: string, readonly status: number, readonly codes: number[] = []) {
    super(message);
  }
}

export interface CfZone {
  id: string;
  name: string;
  account: { id: string; name: string };
  plan: { legacy_id: string; name: string };
}

export interface RulesetRule {
  id?: string;
  ref?: string;
  description?: string;
  action: string;
  expression: string;
  enabled: boolean;
  action_parameters?: Record<string, unknown>;
  ratelimit?: Record<string, unknown>;
}

export interface Ruleset {
  id: string;
  rules?: RulesetRule[];
}

export interface ListItem {
  id: string;
  ip?: string;
  comment?: string;
}

export type Fetch = typeof fetch;

export class Cloudflare {
  private fetcher: Fetch;

  // Resolves the global fetch at call time: workerd rejects fetch called as a method of another object.
  constructor(private token: string, fetcher?: Fetch) {
    this.fetcher = fetcher ?? ((input, init) => fetch(input, init));
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<{ result: T; result_info?: { cursors?: { after?: string }; total_pages?: number } }> {
    const res = await this.fetcher(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      result?: T;
      result_info?: { cursors?: { after?: string }; total_pages?: number };
      errors?: { code: number; message: string }[];
    };
    if (!res.ok || json.success === false) {
      const errors = json.errors ?? [];
      const msg = errors.map((e) => `${e.code}: ${e.message}`).join("; ") || `HTTP ${res.status}`;
      throw new CfError(`Cloudflare ${method} ${path.split("?")[0]} failed (${msg})`, res.status, errors.map((e) => e.code));
    }
    return { result: json.result as T, result_info: json.result_info };
  }

  async verifyToken(): Promise<boolean> {
    try {
      const { result } = await this.call<{ status: string }>("GET", "/user/tokens/verify");
      return result.status === "active";
    } catch {
      // Account-owned tokens can't use the user endpoint; listing zones below proves they work.
      return true;
    }
  }

  async listZones(): Promise<CfZone[]> {
    const zones: CfZone[] = [];
    for (let page = 1; page <= 20; page++) {
      const { result, result_info } = await this.call<CfZone[]>("GET", `/zones?per_page=50&page=${page}`);
      zones.push(...result);
      if (!result_info?.total_pages || page >= result_info.total_pages) break;
    }
    return zones;
  }

  async getZone(zoneId: string): Promise<CfZone> {
    return (await this.call<CfZone>("GET", `/zones/${zoneId}`)).result;
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.fetcher(`${API}/graphql`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const json = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message: string }[] | null };
    if (!res.ok || (json.errors && json.errors.length)) {
      throw new CfError(`Analytics query failed (${json.errors?.map((e) => e.message).join("; ") ?? res.status})`, res.status);
    }
    return json.data as T;
  }

  // Lists (account level)

  async findList(accountId: string, name: string): Promise<{ id: string } | undefined> {
    const { result } = await this.call<{ id: string; name: string }[]>("GET", `/accounts/${accountId}/rules/lists`);
    return result.find((l) => l.name === name);
  }

  async createIpList(accountId: string, name: string, description: string): Promise<{ id: string }> {
    return (await this.call<{ id: string }>("POST", `/accounts/${accountId}/rules/lists`, { name, kind: "ip", description })).result;
  }

  async listItems(accountId: string, listId: string): Promise<ListItem[]> {
    const items: ListItem[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 50; i++) {
      const q = cursor ? `?per_page=500&cursor=${encodeURIComponent(cursor)}` : "?per_page=500";
      const { result, result_info } = await this.call<ListItem[]>("GET", `/accounts/${accountId}/rules/lists/${listId}/items${q}`);
      items.push(...result);
      cursor = result_info?.cursors?.after;
      if (!cursor) break;
    }
    return items;
  }

  async addListItems(accountId: string, listId: string, items: { ip: string; comment: string }[]): Promise<void> {
    if (items.length) await this.call("POST", `/accounts/${accountId}/rules/lists/${listId}/items`, items);
  }

  async deleteListItems(accountId: string, listId: string, ids: string[]): Promise<void> {
    if (ids.length) await this.call("DELETE", `/accounts/${accountId}/rules/lists/${listId}/items`, { items: ids.map((id) => ({ id })) });
  }

  // Rulesets (zone level)

  async getEntrypoint(zoneId: string, phase: string): Promise<Ruleset | undefined> {
    try {
      return (await this.call<Ruleset>("GET", `/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`)).result;
    } catch (e) {
      if (e instanceof CfError && e.status === 404) return undefined;
      throw e;
    }
  }

  /** Adds a rule without touching the zone's other rules. Returns the rule with its id. */
  async addRule(zoneId: string, phase: string, rule: RulesetRule): Promise<{ rulesetId: string; rule: RulesetRule }> {
    const entry = await this.getEntrypoint(zoneId, phase);
    let ruleset: Ruleset;
    if (!entry) {
      // No entrypoint yet means the zone has no rules in this phase, so creating it can't overwrite anything.
      ruleset = (await this.call<Ruleset>("PUT", `/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`, { rules: [rule] })).result;
    } else {
      ruleset = (await this.call<Ruleset>("POST", `/zones/${zoneId}/rulesets/${entry.id}/rules`, rule)).result;
    }
    const created = ruleset.rules?.find((r) => r.ref === rule.ref);
    if (!created?.id) throw new CfError(`Rule ${rule.ref} was not created`, 500);
    return { rulesetId: ruleset.id, rule: created };
  }

  async updateRule(zoneId: string, rulesetId: string, ruleId: string, rule: RulesetRule): Promise<void> {
    await this.call("PATCH", `/zones/${zoneId}/rulesets/${rulesetId}/rules/${ruleId}`, rule);
  }

  async deleteRule(zoneId: string, rulesetId: string, ruleId: string): Promise<void> {
    try {
      await this.call("DELETE", `/zones/${zoneId}/rulesets/${rulesetId}/rules/${ruleId}`);
    } catch (e) {
      if (!(e instanceof CfError && e.status === 404)) throw e;
    }
  }
}
