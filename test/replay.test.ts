// Replays a spike through the whole loop (poll, baseline, cluster, sanitize, judge, decide,
// enforce, reconcile) inside workerd with real D1 and KV. Cloudflare and Jev are faked at the
// HTTP boundary, so this also checks exactly what Spikeward would send to each.
import { env as testEnv, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Cloudflare } from "../src/cf/client";
import { saveCredential, loadCredential } from "../src/credentials";
import { migrate, setMeta, type ZoneRow } from "../src/db";
import { provisionZone, sync } from "../src/loop/enforce";
import { tickZone } from "../src/loop/tick";
import { saveSettings } from "../src/settings";
import type { Env } from "../src/env";
import fixture from "./fixtures/spikes/synthetic-mixed.json";

const env = testEnv as unknown as Env;

const ZONE = "zone123";
const ACCOUNT = "acct123";
const AT = new Date("2026-09-29T11:44:10Z");

interface FakeRule { id: string; ref?: string; action: string; expression: string; enabled: boolean; description?: string }

function fakeWorld() {
  const lists: { id: string; name: string; items: { id: string; ip: string; comment: string }[] }[] = [];
  const rulesets = new Map<string, { id: string; rules: FakeRule[] }>();
  const jevBodies: string[] = [];
  const graphqlQueries: string[] = [];
  const alerts: string[] = [];
  // Fields the zone may read; tests narrow this to model a Free zone.
  let fields = ["clientIP", "clientCountryName", "userAgent", "clientRequestPath", "clientRequestHTTPMethodName", "edgeResponseStatus",
    "edgeResponseContentTypeName", "verifiedBotCategory", "securityAction", "clientAsn", "clientASNDescription", "clientRequestQuery", "requestSource"];
  let seq = 0;
  const ok = (result: unknown, extra: object = {}) => Response.json({ success: true, errors: [], result, ...extra });
  const notFound = () => Response.json({ success: false, errors: [{ code: 10003, message: "not found" }] }, { status: 404 });

  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const method = req.method;
    const path = url.pathname.replace("/client/v4", "");
    const json = async () => JSON.parse((await req.text()) || "null");

    if (url.hostname === "api.typesafe.ai") {
      const text = await req.text();
      jevBodies.push(text);
      return Response.json(fakeJev(JSON.parse(text)));
    }
    if (url.hostname === "hooks.example") {
      alerts.push(((await json()) as { text: string }).text);
      return new Response("ok");
    }
    if (url.hostname !== "api.cloudflare.com") throw new Error(`Unexpected fetch ${req.url}`);

    if (path === "/graphql") {
      const { query } = (await json()) as { query: string };
      if (query.includes("SpikewardFields")) {
        const availableFields = ["count", ...fields.map((f) => `dimensions_${f}`)];
        return Response.json({ data: { viewer: { zones: [{ settings: { httpRequestsAdaptiveGroups: { enabled: true, availableFields } } }] } } });
      }
      graphqlQueries.push(query);
      // Like Cloudflare, only return the dimensions that were asked for.
      const asked = new Set(query.split("dimensions {").pop()!.split("}")[0]!.trim().split(/\s+/));
      const z = fixture.data.viewer.zones[0]!;
      const groups = z.groups.map((g) => ({ count: g.count, dimensions: Object.fromEntries(Object.entries(g.dimensions).filter(([k]) => asked.has(k))) }));
      return Response.json({ data: { viewer: { zones: [{ totals: z.totals, groups }] } }, errors: null });
    }
    if (path === `/zones/${ZONE}`) return ok({ id: ZONE, name: "example.com", account: { id: ACCOUNT, name: "Acct" }, plan: { legacy_id: "pro", name: "Pro" } });
    if (path === `/accounts/${ACCOUNT}/rules/lists`) {
      if (method === "GET") return ok(lists.map(({ id, name }) => ({ id, name })));
      const b = (await json()) as { name: string };
      const list = { id: `list${++seq}`, name: b.name, items: [] };
      lists.push(list);
      return ok({ id: list.id, name: list.name });
    }
    const items = path.match(/^\/accounts\/[^/]+\/rules\/lists\/([^/]+)\/items$/);
    if (items) {
      const list = lists.find((l) => l.id === items[1])!;
      if (method === "GET") return ok(list.items, { result_info: { cursors: {} } });
      if (method === "POST") {
        for (const it of (await json()) as { ip: string; comment: string }[]) list.items.push({ id: `item${++seq}`, ...it });
        return ok({ operation_id: "op" });
      }
      const del = ((await json()) as { items: { id: string }[] }).items.map((i) => i.id);
      list.items = list.items.filter((i) => !del.includes(i.id));
      return ok({ operation_id: "op" });
    }
    const entry = path.match(/^\/zones\/[^/]+\/rulesets\/phases\/([^/]+)\/entrypoint$/);
    if (entry) {
      const phase = entry[1]!;
      if (method === "GET") return rulesets.has(phase) ? ok(rulesets.get(phase)) : notFound();
      const b = (await json()) as { rules: FakeRule[] };
      const rs = { id: `rs-${phase}`, rules: b.rules.map((r) => ({ ...r, id: `rule${++seq}` })) };
      rulesets.set(phase, rs);
      return ok(rs);
    }
    const rules = path.match(/^\/zones\/[^/]+\/rulesets\/([^/]+)\/rules(?:\/([^/]+))?$/);
    if (rules) {
      const rs = [...rulesets.values()].find((r) => r.id === rules[1])!;
      if (method === "POST") {
        rs.rules.push({ ...((await json()) as FakeRule), id: `rule${++seq}` });
        return ok(rs);
      }
      const i = rs.rules.findIndex((r) => r.id === rules[2]);
      if (method === "PATCH") rs.rules[i] = { ...rs.rules[i]!, ...((await json()) as FakeRule), id: rules[2]! };
      if (method === "DELETE") rs.rules.splice(i, 1);
      return ok(rs);
    }
    throw new Error(`Unhandled Cloudflare call ${method} ${path}`);
  };

  const rule = (ref: string) => rulesets.get("http_request_firewall_custom")?.rules.find((r) => r.ref === ref);
  const setFields = (f: string[]) => (fields = f);
  return { handler, lists, rulesets, jevBodies, graphqlQueries, alerts, rule, setFields };
}

/** A stand-in for Jev that answers from the same features the real model sees. */
function fakeJev(body: { state: { cluster: Record<string, any> } }) {
  const c = body.state.cluster;
  const flagged = Object.values(c.flags as Record<string, boolean>).some(Boolean);
  const automated = c.hosting_asn || c.rate_4xx > 0.3 || flagged || (c.asset_to_page_ratio ?? 0) < 0.1 ? 0.97 : 0.08;
  const welcome = (c.user_agents as string[]).some((u) => u.includes("Uptime")) ? 0.95 : 0.03;
  const harm = c.login_share > 0.5 ? 4 : flagged ? 3.5 : 2;
  const intent = c.login_share > 0.5 ? "credential_stuffing" : flagged ? "vuln_scanner" : automated > 0.5 ? "scraper" : "human_burst";
  return {
    model: "jev-test",
    answers: {
      is_automated: { type: "noul", noul: automated },
      is_welcome: { type: "noul", noul: welcome },
      intent: { type: "choice", choice: intent, probabilities: { [intent]: 1 }, confidence: 1 },
      harm: { type: "score", score: harm, probabilities: {}, confidence: 0.9 },
      action: { type: "choice", choice: "block", probabilities: { block: 1 }, confidence: 1 },
    },
    usage: { input_tokens: 600, output_tokens: 20 },
  };
}

let world: ReturnType<typeof fakeWorld>;

async function setup(mode: "shadow" | "enforce", withJev = true) {
  await migrate(env);
  for (const t of ["zones", "decisions", "actions", "spikes", "allowlist", "settings", "credentials", "usage", "users"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
  await env.DB.prepare("DELETE FROM meta WHERE key LIKE 'list:%' OR key LIKE 'lock:%' OR key = 'kill'").run();
  for (const k of (await env.KV.list()).keys) await env.KV.delete(k.name);

  await saveCredential(env, "cloudflare", "cf-test-token");
  if (withJev) await saveCredential(env, "jev", "jev-test-key");
  await setMeta(env, "origin", "https://spikeward.example");
  await saveSettings(env, "", { alerts: { webhookUrl: "https://hooks.example/alert" }, jev: { siteDescription: "an online course site with member login" } });
  await env.DB.prepare("INSERT INTO allowlist (zone_id, kind, value, note, created_at) VALUES ('', 'ip', '192.0.2.10', 'uptime monitor', 0)").run();
  await env.DB.prepare("INSERT INTO zones (zone_id, name, account_id, plan, mode, created_at) VALUES (?, 'example.com', ?, 'pro', ?, 0)")
    .bind(ZONE, ACCOUNT, mode).run();
  await env.KV.put(`baseline:${ZONE}:all`, JSON.stringify({ v: 350, n: 50 }));

  const cf = new Cloudflare("cf-test-token");
  await provisionZone(env, cf, (await zoneRow())!);
  return cf;
}

const zoneRow = () => env.DB.prepare("SELECT * FROM zones WHERE zone_id = ?").bind(ZONE).first<ZoneRow>();

async function tick(cf: Cloudflare, at = AT) {
  await tickZone(env, cf, (await zoneRow())!, await loadCredential(env, "jev"), at);
  await sync(env);
}

async function decisions() {
  const { results } = await env.DB.prepare("SELECT cluster_key, cluster_kind, target, action, applied, source, reason FROM decisions ORDER BY id").all<{
    cluster_key: string; cluster_kind: string; target: string; action: string; applied: number; source: string; reason: string;
  }>();
  return results;
}

beforeEach(() => {
  world = fakeWorld();
  vi.stubGlobal("fetch", world.handler);
});
afterEach(() => vi.unstubAllGlobals());

describe("replay: synthetic mixed spike", () => {
  it("enforce mode: blocks the attackers, challenges the scraper network, leaves people alone", async () => {
    const cf = await setup("enforce");
    await tick(cf);

    const spike = await env.DB.prepare("SELECT * FROM spikes").first<{ peak_rpm: number; baseline_rpm: number }>();
    expect(spike).toMatchObject({ peak_rpm: 4200, baseline_rpm: 350 });

    const byTarget = Object.fromEntries((await decisions()).map((d) => [d.target, d]));
    expect(byTarget["203.0.113.50"]).toMatchObject({ action: "block", applied: 1, source: "jev" });
    expect(byTarget["198.51.100.7"]).toMatchObject({ action: "block", applied: 1 });
    expect(byTarget["14061"]).toMatchObject({ action: "managed_challenge", applied: 1 });
    for (const asn of ["7922", "701", "3320"]) expect(byTarget[asn]?.action).toBe("allow");
    // Verified bots and never-block entries are never judged.
    expect(byTarget["66.249.66.1"]).toBeUndefined();
    expect(byTarget["192.0.2.10"]).toBeUndefined();

    const list = world.lists.find((l) => l.name === "spikeward_blocks")!;
    expect(list.items.map((i) => i.ip).sort()).toEqual(["198.51.100.7", "203.0.113.50"]);
    expect(world.rule("spikeward_block")).toMatchObject({ enabled: true, action: "block", expression: "(ip.src in $spikeward_blocks)" });
    expect(world.rule("spikeward_challenge")).toMatchObject({ enabled: true, action: "managed_challenge", expression: "(ip.src.asnum in {14061})" });

    expect(world.alerts.some((a) => a.startsWith("Spike on example.com"))).toBe(true);
  });

  it("never sends raw IPs or attack strings to Jev", async () => {
    const cf = await setup("enforce");
    await tick(cf);
    expect(world.jevBodies.length).toBeGreaterThan(0);
    for (const body of world.jevBodies) {
      expect(body).not.toMatch(/203\.0\.113\.50|198\.51\.100\.7|159\.203\.|UNION|passwd|\.\.\//i);
      const parsed = JSON.parse(body);
      expect(parsed.model).toBe("jev-latest");
      expect(Object.keys(parsed.questions)).toEqual(["is_automated", "is_welcome", "intent", "harm", "action"]);
    }
  });

  it("shadow mode: records what it would do and applies nothing", async () => {
    const cf = await setup("shadow");
    await tick(cf);
    const ds = await decisions();
    expect(ds.find((d) => d.target === "203.0.113.50")).toMatchObject({ action: "block", applied: 0 });
    expect(ds.every((d) => d.applied === 0)).toBe(true);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM actions").first<{ n: number }>())!.n).toBe(0);
    expect(world.lists[0]!.items).toHaveLength(0);
    expect(world.rule("spikeward_block")!.enabled).toBe(false);
    expect(world.rule("spikeward_challenge")!.enabled).toBe(false);
  });

  it("caches verdicts and doesn't re-judge targets it already acted on", async () => {
    const cf = await setup("enforce");
    await tick(cf);
    const calls = world.jevBodies.length;
    const before = (await decisions()).length;
    await tick(cf, new Date(AT.getTime() + 60_000));
    const after = await decisions();
    expect(after.slice(before).every((d) => d.source === "cache")).toBe(true);
    expect(after.slice(before).some((d) => d.target === "203.0.113.50")).toBe(false);
    expect(world.jevBodies.length).toBe(calls);
  });

  it("expired actions are removed from Cloudflare by the janitor", async () => {
    const cf = await setup("enforce");
    await tick(cf);
    await env.DB.prepare("UPDATE actions SET expires_at = 1").run();
    await sync(env);
    expect(world.lists[0]!.items).toHaveLength(0);
    expect(world.rule("spikeward_challenge")!.enabled).toBe(false);
    const removed = await env.DB.prepare("SELECT COUNT(*) AS n FROM actions WHERE removed_by = 'expired'").first<{ n: number }>();
    expect(removed!.n).toBe(3);
  });

  it("the kill switch disables every rule without deleting records", async () => {
    const cf = await setup("enforce");
    await tick(cf);
    await setMeta(env, "kill", "1");
    await sync(env);
    expect(world.rule("spikeward_block")!.enabled).toBe(false);
    expect(world.rule("spikeward_challenge")!.enabled).toBe(false);
    expect(world.lists[0]!.items).toHaveLength(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM actions WHERE removed_at IS NULL").first<{ n: number }>())!.n).toBe(3);
  });

  it("falls back to rules-only without a Jev key, and never blocks", async () => {
    const cf = await setup("enforce", false);
    await tick(cf);
    const ds = await decisions();
    expect(ds.every((d) => d.source === "rules")).toBe(true);
    expect(ds.find((d) => d.target === "203.0.113.50")!.action).toBe("managed_challenge");
    expect(ds.some((d) => d.action === "block")).toBe(false);
    expect(world.jevBodies).toHaveLength(0);
  });

  it("pauses enforcement when the hourly action cap is hit", async () => {
    const cf = await setup("enforce");
    await saveSettings(env, "", { policy: { maxActionsPerHour: 2 } });
    await tick(cf);
    const applied = (await decisions()).filter((d) => d.applied === 1);
    expect(applied).toHaveLength(2);
    expect((await zoneRow())!.paused_until).toBeGreaterThan(Date.now() / 1000);
    expect(world.alerts.some((a) => a.includes("paused enforcement"))).toBe(true);
  });

  it("on a Free zone, asks only for fields the plan can read and still catches the attackers", async () => {
    world.setFields(["clientIP", "clientCountryName", "userAgent", "clientRequestPath", "clientRequestHTTPMethodName", "edgeResponseStatus",
      "edgeResponseContentTypeName", "verifiedBotCategory", "securityAction"]);
    const cf = await setup("enforce");
    await tick(cf);
    const q = world.graphqlQueries[0]!;
    expect(q).not.toMatch(/clientAsn|clientRequestQuery|requestSource|ja4|botScore/);
    const ds = await decisions();
    expect(ds.some((d) => d.cluster_kind === "asn")).toBe(false);
    expect(ds.find((d) => d.target === "203.0.113.50")!.action).toBe("block");
    expect(ds.find((d) => d.target === "198.51.100.7")!.action).toBe("block");
    // Without network data, the scraper is caught by its exact user agent, and only challenged.
    const ua = ds.find((d) => d.cluster_kind === "ua")!;
    expect(ua.action).toBe("managed_challenge");
    expect(world.rule("spikeward_challenge")!.expression).toMatch(/^\(http\.user_agent eq "Mozilla\/5\.0 \(Windows/);
  });

  it("leaves the zone's own rules alone", async () => {
    await migrate(env);
    const cf = new Cloudflare("t");
    world.rulesets.set("http_request_firewall_custom", {
      id: "rs-http_request_firewall_custom",
      rules: [{ id: "user1", ref: "mine", action: "block", expression: '(http.request.uri.path eq "/admin")', enabled: true }],
    });
    await setup("enforce");
    await tick(cf);
    expect(world.rulesets.get("http_request_firewall_custom")!.rules.find((r) => r.id === "user1")).toMatchObject({ enabled: true, action: "block" });
  });
});

describe("api security", () => {
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    SELF.fetch(`https://spikeward.example${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  beforeEach(async () => {
    vi.unstubAllGlobals();
    await migrate(env);
    await env.DB.prepare("DELETE FROM users").run();
    for (const k of (await env.KV.list({ prefix: "rl:" })).keys) await env.KV.delete(k.name);
  });

  it("rejects writes without the CSRF header", async () => {
    const res = await post("/api/setup/claim", { secret: "x", name: "a", password: "0123456789" });
    expect(res.status).toBe(403);
  });

  it("claims with the right secret exactly once, then requires sign-in", async () => {
    const h = { "x-spikeward": "1" };
    expect((await post("/api/setup/claim", { secret: "wrong", name: "admin", password: "correct horse battery" }, h)).status).toBe(403);
    const ok = await post("/api/setup/claim", { secret: "test-secret-for-spikeward-tests", name: "admin", password: "correct horse battery" }, h);
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get("set-cookie")!;
    expect(cookie).toMatch(/sw_session=.+HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);

    expect((await post("/api/setup/claim", { secret: "test-secret-for-spikeward-tests", name: "b", password: "correct horse battery" }, h)).status).toBe(409);
    expect((await SELF.fetch("https://spikeward.example/api/zones")).status).toBe(401);
    const authed = await SELF.fetch("https://spikeward.example/api/state", { headers: { cookie: cookie.split(";")[0]! } });
    expect(await authed.json()).toMatchObject({ claimed: true, user: { name: "admin" } });

    const bad = await post("/api/login", { name: "admin", password: "nope" }, h);
    expect(bad.status).toBe(401);
  });

  it("rejects forged review links", async () => {
    const res = await SELF.fetch("https://spikeward.example/api/review?d=1&op=reject&exp=9999999999&sig=forged");
    expect(res.status).toBe(400);
  });
});
