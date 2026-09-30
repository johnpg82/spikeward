import { Hono } from "hono";
import { z } from "zod";
import { VERSION, REPO } from "../env";
import { csrf, endSession, rateLimited, requireUser, session, startSession, type AppEnv } from "../auth";
import { hashPassword, timingSafeEqual, verifyPassword, verifySig } from "../crypto";
import { activeActions, getMeta, listZones, migrate, now, setMeta, type ZoneRow } from "../db";
import { Cloudflare, CfError } from "../cf/client";
import { credentialStatus, loadCredential, saveCredential } from "../credentials";
import { ask, JevError } from "../jev/client";
import { loadSettings, saveSettings, settingsSchema } from "../settings";
import { cloudflareClient, deprovisionZone, parseRuleIds, provisionZone, sync } from "../loop/enforce";
import { buildQuestions, toVerdict } from "../loop/judge";
import { decide } from "../loop/policy";
import type { RpmPoint } from "../loop/tick";

export const api = new Hono<AppEnv>().basePath("/api");

api.use("*", async (c, next) => {
  await migrate(c.env);
  await next();
});
api.use("*", session);
api.use("*", csrf);

api.onError((err, c) => {
  if (err instanceof z.ZodError) return c.json({ error: "Some values aren't valid.", issues: err.issues }, 400);
  if (err instanceof CfError) return c.json({ error: err.message }, 502);
  if (err instanceof JevError) return c.json({ error: err.message }, 502);
  console.error(err);
  return c.json({ error: "Something went wrong on the server. Check the Worker logs." }, 500);
});

const body = async <T extends z.ZodType>(c: { req: { json: () => Promise<unknown> } }, schema: T): Promise<z.infer<T>> =>
  schema.parse(await c.req.json().catch(() => ({})));

// Setup and sessions

api.get("/state", async (c) => {
  const users = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
  const user = c.get("user");
  if (user) await rememberOrigin(c.env, c.req.url);
  const zones = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM zones").first<{ n: number }>();
  return c.json({
    claimed: (users?.n ?? 0) > 0,
    user,
    version: VERSION,
    ...(user
      ? { credentials: await credentialStatus(c.env), zones: zones?.n ?? 0, kill: (await getMeta(c.env, "kill")) === "1" }
      : {}),
  });
});

async function rememberOrigin(env: AppEnv["Bindings"], url: string) {
  const origin = new URL(url).origin;
  if ((await getMeta(env, "origin")) !== origin) await setMeta(env, "origin", origin);
}

const claimBody = z.object({ secret: z.string().min(1), name: z.string().trim().min(1).max(60), password: z.string().min(10).max(200) });

api.post("/setup/claim", async (c) => {
  if (await rateLimited(c, "claim")) return c.json({ error: "Too many attempts. Wait 15 minutes and try again." }, 429);
  const users = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
  if ((users?.n ?? 0) > 0) return c.json({ error: "This install is already claimed. Sign in instead." }, 409);
  const b = await body(c, claimBody);
  if (!timingSafeEqual(b.secret.trim(), c.env.SPIKEWARD_SECRET)) {
    return c.json({ error: "That isn't the SPIKEWARD_SECRET you set when deploying." }, 403);
  }
  const res = await c.env.DB.prepare("INSERT INTO users (name, password_hash, role, created_at) VALUES (?, ?, 'admin', ?) RETURNING id")
    .bind(b.name, await hashPassword(b.password), now()).first<{ id: number }>();
  await startSession(c, { id: res!.id, name: b.name });
  await rememberOrigin(c.env, c.req.url);
  return c.json({ ok: true });
});

const loginBody = z.object({ name: z.string().trim().min(1), password: z.string().min(1) });

api.post("/login", async (c) => {
  if (await rateLimited(c, "login")) return c.json({ error: "Too many attempts. Wait 15 minutes and try again." }, 429);
  const b = await body(c, loginBody);
  const user = await c.env.DB.prepare("SELECT id, name, password_hash FROM users WHERE name = ?").bind(b.name)
    .first<{ id: number; name: string; password_hash: string }>();
  if (!user || !(await verifyPassword(b.password, user.password_hash))) {
    return c.json({ error: "Name or password is incorrect." }, 401);
  }
  await startSession(c, { id: user.id, name: user.name });
  return c.json({ ok: true });
});

api.post("/logout", (c) => {
  endSession(c);
  return c.json({ ok: true });
});

// Signed links from grey-zone alerts; no login needed.
api.get("/review", async (c) => {
  const { d, op, exp, sig } = c.req.query();
  const page = (msg: string, status: 200 | 400 = 200) =>
    c.html(`<!doctype html><meta name="viewport" content="width=device-width"><title>Spikeward</title><body style="font:16px system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><p>${msg}</p><p><a href="/decisions">Open Spikeward</a></p>`, status);
  if (!d || !op || !exp || !sig || Number(exp) < Date.now() / 1000) return page("This review link has expired. Open the Decisions screen instead.", 400);
  if (!(await verifySig(c.env.SPIKEWARD_SECRET, "review", `${d}|${op}|${exp}`, sig))) return page("This review link isn't valid.", 400);
  if (op === "reject") {
    await undoDecision(c.env, Number(d), "review link", true);
    c.executionCtx.waitUntil(sync(c.env));
    return page("Undone. The target is on your never-block list.");
  }
  await c.env.DB.prepare("UPDATE decisions SET reason = reason || ' Kept after review.' WHERE id = ?").bind(Number(d)).run();
  return page("Kept. The action stays until it expires.");
});

// Everything below needs a signed-in admin.
api.use("*", requireUser);

api.post("/credentials/cloudflare", async (c) => {
  const b = await body(c, z.object({ token: z.string().trim().min(20) }));
  const cf = new Cloudflare(b.token);
  if (!(await cf.verifyToken())) return c.json({ error: "Cloudflare says this token isn't active." }, 400);
  let zones;
  try {
    zones = await cf.listZones();
  } catch (e) {
    if (e instanceof CfError && e.status >= 400 && e.status < 500) {
      return c.json({ error: "Cloudflare rejected this token. Check that you copied all of it and that it has Zone: Read." }, 400);
    }
    throw e;
  }
  if (!zones.length) return c.json({ error: "The token works but can't see any zones. Add zone access to the token." }, 400);
  await saveCredential(c.env, "cloudflare", b.token, { zones: zones.length });
  return c.json({ zones: zones.map(zoneSummary) });
});

api.get("/cloudflare/zones", async (c) => {
  const cf = await cloudflareClient(c.env);
  if (!cf) return c.json({ error: "Connect Cloudflare first." }, 400);
  return c.json({ zones: (await cf.listZones()).map(zoneSummary) });
});

const zoneSummary = (z: { id: string; name: string; plan: { legacy_id: string }; account: { id: string; name: string } }) => ({
  id: z.id,
  name: z.name,
  plan: z.plan.legacy_id,
  account: z.account.name,
});

api.post("/credentials/jev", async (c) => {
  const b = await body(
    c,
    z.object({ key: z.string().trim().min(10), baseUrl: z.string().url().optional(), model: z.string().min(1).optional() }),
  );
  const settings = await loadSettings(c.env);
  const cfg = { apiKey: b.key, baseUrl: b.baseUrl ?? settings.jev.baseUrl, model: b.model ?? settings.jev.model };
  const res = await ask(cfg, "An uptime monitor requests /health once a minute.", {
    ok: { type: "noul", instructions: "Is this traffic automated?" },
  });
  await saveCredential(c.env, "jev", b.key, { model: res.model });
  if (b.baseUrl || b.model) await saveSettings(c.env, "", { jev: { baseUrl: cfg.baseUrl, model: cfg.model } });
  return c.json({ ok: true, model: res.model, tokens: res.usage.input_tokens });
});

// Zones

function features(plan: string) {
  const ent = plan === "enterprise";
  return {
    polling: true,
    ipBlocks: true,
    challenges: true,
    ipLists: ent ? 1000 : plan === "free" ? 1 : 10,
    ja4: ent,
    botScore: ent,
    ja4RateLimit: ent,
  };
}

api.get("/zones", async (c) => {
  const zones = await listZones(c.env);
  const out = await Promise.all(
    zones.map(async (z) => {
      const [series, spike, active] = await Promise.all([
        c.env.KV.get<RpmPoint[]>(`rpm:${z.zone_id}`, "json"),
        c.env.KV.get<{ id: number; peak: number }>(`spike:${z.zone_id}`, "json"),
        c.env.DB.prepare("SELECT COUNT(*) AS n FROM actions WHERE zone_id = ? AND removed_at IS NULL AND expires_at > ?")
          .bind(z.zone_id, now()).first<{ n: number }>(),
      ]);
      return {
        id: z.zone_id,
        name: z.name,
        plan: z.plan,
        mode: z.mode,
        shadowSince: z.shadow_since,
        pausedUntil: z.paused_until && z.paused_until > now() ? z.paused_until : null,
        lastTickAt: z.last_tick_at,
        lastError: z.last_error,
        features: features(z.plan),
        series: series ?? [],
        spike,
        activeActions: active?.n ?? 0,
        rules: parseRuleIds(z),
      };
    }),
  );
  return c.json({ zones: out });
});

api.post("/zones", async (c) => {
  const b = await body(c, z.object({ zoneId: z.string().min(1) }));
  const cf = await cloudflareClient(c.env);
  if (!cf) return c.json({ error: "Connect Cloudflare first." }, 400);
  const cz = await cf.getZone(b.zoneId);
  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO zones (zone_id, name, account_id, plan, mode, shadow_since, created_at) VALUES (?, ?, ?, ?, 'shadow', ?, ?)",
  ).bind(cz.id, cz.name, cz.account.id, cz.plan.legacy_id, now(), now()).run();
  const zone = (await c.env.DB.prepare("SELECT * FROM zones WHERE zone_id = ?").bind(cz.id).first<ZoneRow>())!;
  try {
    await provisionZone(c.env, cf, zone);
  } catch (e) {
    const msg = (e as Error).message;
    await c.env.DB.prepare("UPDATE zones SET last_error = ? WHERE zone_id = ?").bind(`Setup: ${msg}`, cz.id).run();
    return c.json({ error: `Couldn't create Spikeward's rules on ${cz.name}. ${msg}` }, 502);
  }
  return c.json({ ok: true });
});

api.patch("/zones/:id", async (c) => {
  const b = await body(c, z.object({ mode: z.enum(["off", "shadow", "enforce"]) }));
  const id = c.req.param("id");
  await c.env.DB.prepare(
    "UPDATE zones SET mode = ?, shadow_since = CASE WHEN ? = 'shadow' THEN ? ELSE shadow_since END, paused_until = CASE WHEN ? = 'enforce' THEN NULL ELSE paused_until END WHERE zone_id = ?",
  ).bind(b.mode, b.mode, now(), b.mode, id).run();
  c.executionCtx.waitUntil(sync(c.env));
  return c.json({ ok: true });
});

api.delete("/zones/:id", async (c) => {
  const zone = await c.env.DB.prepare("SELECT * FROM zones WHERE zone_id = ?").bind(c.req.param("id")).first<ZoneRow>();
  if (!zone) return c.json({ error: "Zone not found." }, 404);
  const cf = await cloudflareClient(c.env);
  if (cf) await deprovisionZone(c.env, cf, zone);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM zones WHERE zone_id = ?").bind(zone.zone_id),
    c.env.DB.prepare("DELETE FROM settings WHERE zone_id = ?").bind(zone.zone_id),
  ]);
  c.executionCtx.waitUntil(sync(c.env));
  return c.json({ ok: true });
});

// Decisions and actions

api.get("/decisions", async (c) => {
  const { zone, before, action } = c.req.query();
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
  const where: string[] = [];
  const args: unknown[] = [];
  if (zone) (where.push("d.zone_id = ?"), args.push(zone));
  if (before) (where.push("d.id < ?"), args.push(Number(before)));
  if (action) (where.push("d.action = ?"), args.push(action));
  const sql = `SELECT d.*, z.name AS zone_name,
      (SELECT json_object('id', a.id, 'expires_at', a.expires_at, 'removed_at', a.removed_at, 'removed_by', a.removed_by)
         FROM actions a WHERE a.decision_id = d.id) AS action_row
    FROM decisions d LEFT JOIN zones z ON z.zone_id = d.zone_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY d.id DESC LIMIT ?`;
  const { results } = await c.env.DB.prepare(sql).bind(...args, limit).all<Record<string, unknown>>();
  return c.json({
    decisions: results.map((r) => ({
      id: r.id,
      zoneId: r.zone_id,
      zoneName: r.zone_name,
      spikeId: r.spike_id,
      clusterKey: r.cluster_key,
      kind: r.cluster_kind,
      state: JSON.parse(String(r.features)),
      answers: r.jev_answers ? JSON.parse(String(r.jev_answers)) : null,
      source: r.source,
      action: r.action,
      reason: r.reason,
      applied: !!r.applied,
      createdAt: r.created_at,
      actionRow: r.action_row ? JSON.parse(String(r.action_row)) : null,
    })),
  });
});

async function undoDecision(env: AppEnv["Bindings"], id: number, by: string, alwaysAllow: boolean) {
  const d = await env.DB.prepare("SELECT zone_id, cluster_kind, target FROM decisions WHERE id = ?").bind(id)
    .first<{ zone_id: string; cluster_kind: string; target: string }>();
  if (!d) return false;
  await env.DB.prepare("UPDATE actions SET removed_at = ?, removed_by = ? WHERE decision_id = ? AND removed_at IS NULL")
    .bind(now(), by, id).run();
  await env.DB.prepare("UPDATE decisions SET reason = reason || ? WHERE id = ?")
    .bind(alwaysAllow ? " Undone and always allowed." : " Undone.", id).run();
  const kind = d.cluster_kind === "ip24" ? "ip" : d.cluster_kind;
  if (alwaysAllow && ["ip", "asn", "ua"].includes(kind)) {
    await env.DB.prepare("INSERT INTO allowlist (zone_id, kind, value, note, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(d.zone_id, kind, d.target, `Always allowed from decision ${id}`, now()).run();
  }
  return true;
}

api.post("/decisions/:id/undo", async (c) => {
  const ok = await undoDecision(c.env, Number(c.req.param("id")), c.get("user")!.name, false);
  c.executionCtx.waitUntil(sync(c.env));
  return ok ? c.json({ ok: true }) : c.json({ error: "Decision not found." }, 404);
});

api.post("/decisions/:id/allow", async (c) => {
  const ok = await undoDecision(c.env, Number(c.req.param("id")), c.get("user")!.name, true);
  c.executionCtx.waitUntil(sync(c.env));
  return ok ? c.json({ ok: true }) : c.json({ error: "Decision not found." }, 404);
});

api.get("/actions", async (c) => {
  const rows = await activeActions(c.env, c.req.query("zone") || undefined);
  const names = new Map((await listZones(c.env)).map((z) => [z.zone_id, z.name]));
  return c.json({ actions: rows.map((a) => ({ ...a, zone_name: names.get(a.zone_id) ?? a.zone_id })) });
});

api.post("/actions/:id/remove", async (c) => {
  await c.env.DB.prepare("UPDATE actions SET removed_at = ?, removed_by = ? WHERE id = ? AND removed_at IS NULL")
    .bind(now(), c.get("user")!.name, Number(c.req.param("id"))).run();
  c.executionCtx.waitUntil(sync(c.env));
  return c.json({ ok: true });
});

api.post("/actions/:id/extend", async (c) => {
  const b = await body(c, z.object({ seconds: z.number().int().min(-7 * 86400).max(7 * 86400) }));
  // Shortening past now expires it; the next sync removes it from Cloudflare.
  await c.env.DB.prepare("UPDATE actions SET expires_at = MAX(expires_at + ?, ?) WHERE id = ? AND removed_at IS NULL")
    .bind(b.seconds, now(), Number(c.req.param("id"))).run();
  c.executionCtx.waitUntil(sync(c.env));
  return c.json({ ok: true });
});

api.post("/killswitch", async (c) => {
  const b = await body(c, z.object({ on: z.boolean() }));
  await setMeta(c.env, "kill", b.on ? "1" : "0");
  await sync(c.env);
  return c.json({ ok: true, kill: b.on });
});

// Settings and never-block list

api.get("/settings", async (c) => {
  const zone = c.req.query("zone") ?? "";
  const overrides = zone
    ? Object.fromEntries(
        (await c.env.DB.prepare("SELECT key, value FROM settings WHERE zone_id = ?").bind(zone).all<{ key: string; value: string }>())
          .results.map((r) => [r.key, JSON.parse(r.value)]),
      )
    : {};
  return c.json({ settings: await loadSettings(c.env, zone), overrides });
});

api.put("/settings", async (c) => {
  const zone = c.req.query("zone") ?? "";
  const patch = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  return c.json({ settings: await saveSettings(c.env, zone, patch) });
});

api.delete("/settings", async (c) => {
  const zone = c.req.query("zone");
  if (!zone) return c.json({ error: "Pass ?zone= to clear a zone's overrides." }, 400);
  await c.env.DB.prepare("DELETE FROM settings WHERE zone_id = ?").bind(zone).run();
  return c.json({ ok: true });
});

api.get("/allowlist", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM allowlist ORDER BY id DESC").all();
  return c.json({ entries: results });
});

const allowBody = z.object({
  zoneId: z.string().default(""),
  kind: z.enum(["ip", "asn", "ua", "path"]),
  value: z.string().trim().min(1).max(500),
  note: z.string().max(200).optional(),
});

api.post("/allowlist", async (c) => {
  const b = await body(c, allowBody);
  await c.env.DB.prepare("INSERT INTO allowlist (zone_id, kind, value, note, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(b.zoneId, b.kind, b.value, b.note ?? null, now()).run();
  return c.json({ ok: true });
});

api.delete("/allowlist/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM allowlist WHERE id = ?").bind(Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});

// Jev: usage and "test against last spike"

api.get("/usage", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM usage ORDER BY day DESC LIMIT 30").all();
  return c.json({ days: results });
});

api.post("/jev/test", async (c) => {
  const cred = await loadCredential(c.env, "jev");
  if (!cred) return c.json({ error: "Add a Jev key first." }, 400);
  const spike = await c.env.DB.prepare("SELECT id, zone_id FROM spikes ORDER BY id DESC LIMIT 1").first<{ id: number; zone_id: string }>();
  if (!spike) return c.json({ error: "No spike recorded yet. Tests run against real spike data." }, 400);
  const { results } = await c.env.DB.prepare(
    "SELECT id, cluster_key, cluster_kind, features, action FROM decisions WHERE spike_id = ? ORDER BY id DESC LIMIT 10",
  ).bind(spike.id).all<{ id: number; cluster_key: string; cluster_kind: string; features: string; action: string }>();
  const settings = await loadSettings(c.env, spike.zone_id);
  const questions = buildQuestions(settings.jev.customQuestions);
  const cfg = { apiKey: cred.value, baseUrl: settings.jev.baseUrl, model: settings.jev.model };
  const out = await Promise.all(
    results.map(async (d) => {
      const res = await ask(cfg, JSON.parse(d.features), questions);
      const policy = decide(d.cluster_kind as never, toVerdict(res.answers), settings.policy, settings.jev.customQuestions);
      return { decisionId: d.id, clusterKey: d.cluster_key, before: d.action, after: policy.action, reason: policy.reason, answers: res.answers };
    }),
  );
  return c.json({ spikeId: spike.id, results: out });
});

// Admin users

api.get("/users", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, name, role, created_at FROM users ORDER BY id").all();
  return c.json({ users: results });
});

api.post("/users", async (c) => {
  const b = await body(c, z.object({ name: z.string().trim().min(1).max(60), password: z.string().min(10).max(200) }));
  const exists = await c.env.DB.prepare("SELECT 1 FROM users WHERE name = ?").bind(b.name).first();
  if (exists) return c.json({ error: "Someone already uses that name." }, 409);
  await c.env.DB.prepare("INSERT INTO users (name, password_hash, role, created_at) VALUES (?, ?, 'admin', ?)")
    .bind(b.name, await hashPassword(b.password), now()).run();
  return c.json({ ok: true });
});

api.delete("/users/:id", async (c) => {
  const n = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
  if ((n?.n ?? 0) <= 1) return c.json({ error: "You can't remove the last admin." }, 400);
  await c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});

api.post("/users/me/password", async (c) => {
  const b = await body(c, z.object({ current: z.string(), password: z.string().min(10).max(200) }));
  const user = await c.env.DB.prepare("SELECT password_hash FROM users WHERE id = ?").bind(c.get("user")!.id).first<{ password_hash: string }>();
  if (!user || !(await verifyPassword(b.current, user.password_hash))) return c.json({ error: "Current password is incorrect." }, 403);
  await c.env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(await hashPassword(b.password), c.get("user")!.id).run();
  return c.json({ ok: true });
});

// Export, import, updates

api.get("/export", async (c) => {
  const [settings, allowlist, zones] = await Promise.all([
    c.env.DB.prepare("SELECT zone_id, key, value FROM settings").all<{ zone_id: string; key: string; value: string }>(),
    c.env.DB.prepare("SELECT zone_id, kind, value, note FROM allowlist").all(),
    c.env.DB.prepare("SELECT zone_id, name, mode FROM zones").all(),
  ]);
  return c.json({
    spikeward: VERSION,
    exportedAt: new Date().toISOString(),
    settings: settings.results.map((r) => ({ ...r, value: JSON.parse(r.value) })),
    allowlist: allowlist.results,
    zones: zones.results,
  });
});

const importBody = z.object({
  settings: z.array(z.object({ zone_id: z.string(), key: z.string(), value: z.unknown() })),
  allowlist: z.array(z.object({ zone_id: z.string(), kind: z.enum(["ip", "asn", "ua", "path"]), value: z.string(), note: z.string().nullable().optional() })),
});

api.post("/import", async (c) => {
  const b = await body(c, importBody);
  const global = Object.fromEntries(b.settings.filter((s) => s.zone_id === "").map((s) => [s.key, s.value]));
  settingsSchema.parse(global);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM settings"),
    c.env.DB.prepare("DELETE FROM allowlist"),
    ...b.settings.map((s) =>
      c.env.DB.prepare("INSERT INTO settings (zone_id, key, value) VALUES (?, ?, ?)").bind(s.zone_id, s.key, JSON.stringify(s.value)),
    ),
    ...b.allowlist.map((a) =>
      c.env.DB.prepare("INSERT INTO allowlist (zone_id, kind, value, note, created_at) VALUES (?, ?, ?, ?, ?)").bind(a.zone_id, a.kind, a.value, a.note ?? null, now()),
    ),
  ]);
  return c.json({ ok: true });
});

api.get("/version", async (c) => {
  const cached = await c.env.KV.get<{ latest: string | null; url: string | null }>("release", "json");
  let info = cached;
  if (!info) {
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { "User-Agent": "spikeward" } });
      const j = res.ok ? ((await res.json()) as { tag_name: string; html_url: string }) : null;
      info = { latest: j?.tag_name?.replace(/^v/, "") ?? null, url: j?.html_url ?? null };
    } catch {
      info = { latest: null, url: null };
    }
    await c.env.KV.put("release", JSON.stringify(info), { expirationTtl: 21600 });
  }
  return c.json({ current: VERSION, ...info, updateAvailable: !!info.latest && info.latest !== VERSION });
});
