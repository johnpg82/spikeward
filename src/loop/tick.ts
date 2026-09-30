import type { Env } from "../env";
import type { Cloudflare } from "../cf/client";
import { loadCredential } from "../credentials";
import { activeActions, getMeta, listZones, now, tryLock, unlock, type ClusterKind, type Mechanism, type ZoneRow } from "../db";
import type { JevConfig } from "../jev/client";
import { loadSettings, type Settings } from "../settings";
import { reviewLinks, sendAlert } from "../alerts";
import { expectedRpm, GLOBAL_ALPHA, hourOfWeek, HOW_ALPHA, isSpike, updateEwma, type Ewma } from "./baseline";
import { buildClusters, type Cluster } from "./cluster";
import { cloudflareClient, sync } from "./enforce";
import { buildState, judge } from "./judge";
import { decide, decideRulesOnly, ttlFor, type PolicyResult } from "./policy";
import { availableFields, FREE_FIELDS, poll, type PollResult } from "./poll";

interface SpikeState {
  id: number;
  calm: number;
  peak: number;
}

interface AllowEntry {
  zone_id: string;
  kind: string;
  value: string;
}

export interface RpmPoint {
  t: number;
  rpm: number;
  baseline: number | null;
}

/** The whole loop: every managed zone, then one reconcile pass against Cloudflare. */
export async function runTick(env: Env, at = new Date()): Promise<void> {
  const cf = await cloudflareClient(env);
  if (!cf) return;
  const jevCred = await loadCredential(env, "jev");
  const zones = (await listZones(env)).filter((z) => z.mode !== "off");
  await Promise.allSettled(zones.map((z) => tickZone(env, cf, z, jevCred, at)));
  await sync(env);
  if (at.getUTCHours() === 3 && at.getUTCMinutes() === 17) await prune(env);
}

export async function tickZone(
  env: Env,
  cf: Cloudflare,
  zone: ZoneRow,
  jevCred: { value: string; meta: Record<string, unknown> } | null,
  at = new Date(),
): Promise<void> {
  if (!(await tryLock(env, `zone:${zone.zone_id}`, 55))) return;
  try {
    const settings = await loadSettings(env, zone.zone_id);
    const d = settings.detection;
    const result = await pollZone(env, cf, zone, settings, at);

    // Baseline and spike state
    const how = hourOfWeek(result.to);
    const howKey = `baseline:${zone.zone_id}:${how}`;
    const allKey = `baseline:${zone.zone_id}:all`;
    const [howB, allB, spike] = await Promise.all([
      env.KV.get<Ewma>(howKey, "json"),
      env.KV.get<Ewma>(allKey, "json"),
      env.KV.get<SpikeState>(`spike:${zone.zone_id}`, "json"),
    ]);
    const expected = expectedRpm(howB, allB);
    const spiking = isSpike(result.rpm, expected, d.spikeMultiple, d.spikeFloorRpm);
    await recordRpm(env, zone.zone_id, result, expected);

    let state = spike;
    if (spiking && !state) {
      const row = await env.DB.prepare("INSERT INTO spikes (zone_id, started_at, peak_rpm, baseline_rpm) VALUES (?, ?, ?, ?) RETURNING id")
        .bind(zone.zone_id, now(), result.rpm, expected ?? 0).first<{ id: number }>();
      state = { id: row!.id, calm: 0, peak: result.rpm };
      if (settings.alerts.onSpike) {
        await sendAlert(settings, `Spike on ${zone.name}: ${Math.round(result.rpm)} requests/min against a baseline of ${Math.round(expected ?? 0)}. Mode: ${zone.mode}.`);
      }
    } else if (state) {
      if (result.rpm > state.peak) {
        state.peak = result.rpm;
        await env.DB.prepare("UPDATE spikes SET peak_rpm = ? WHERE id = ?").bind(result.rpm, state.id).run();
      }
      state.calm = spiking ? 0 : state.calm + 1;
      if (state.calm >= d.calmMinutesToEnd) {
        await env.DB.prepare("UPDATE spikes SET ended_at = ? WHERE id = ?").bind(now(), state.id).run();
        state = null;
      }
    }
    if (state) await env.KV.put(`spike:${zone.zone_id}`, JSON.stringify(state), { expirationTtl: 86400 });
    else await env.KV.delete(`spike:${zone.zone_id}`);

    // Only calm traffic teaches the baseline, so an attack can't raise its own threshold.
    if (!state) {
      await Promise.all([
        env.KV.put(howKey, JSON.stringify(updateEwma(howB, result.rpm, HOW_ALPHA))),
        env.KV.put(allKey, JSON.stringify(updateEwma(allB, result.rpm, GLOBAL_ALPHA))),
      ]);
    }

    if (spiking && state) await handleSpike(env, zone, settings, result, expected, state.id, jevCred);

    await env.DB.prepare("UPDATE zones SET last_tick_at = ?, last_error = CASE WHEN last_error LIKE 'Rules:%' THEN last_error ELSE NULL END WHERE zone_id = ?")
      .bind(now(), zone.zone_id).run();
  } catch (e) {
    console.error("tick failed", zone.name, e);
    await env.DB.prepare("UPDATE zones SET last_tick_at = ?, last_error = ? WHERE zone_id = ?")
      .bind(now(), (e as Error).message.slice(0, 500), zone.zone_id).run();
  } finally {
    await unlock(env, `zone:${zone.zone_id}`);
  }
}

async function pollZone(env: Env, cf: Cloudflare, zone: ZoneRow, settings: Settings, at: Date): Promise<PollResult> {
  const d = settings.detection;
  const fields = await zoneFields(env, cf, zone.zone_id);
  return poll(cf, zone.zone_id, { windowMinutes: d.windowMinutes, lagMinutes: d.lagMinutes, fields, at });
}

/** The fields this zone's plan may read, rechecked daily so a plan upgrade is picked up. */
export async function zoneFields(env: Env, cf: Cloudflare, zoneId: string): Promise<string[]> {
  const key = `fields:${zoneId}`;
  const cached = await env.KV.get<string[]>(key, "json");
  if (cached) return cached;
  let fields: string[];
  try {
    fields = await availableFields(cf, zoneId);
  } catch (e) {
    console.error("field lookup failed; using the Free plan set", e);
    fields = FREE_FIELDS;
  }
  await env.KV.put(key, JSON.stringify(fields), { expirationTtl: 86400 });
  return fields;
}

async function recordRpm(env: Env, zoneId: string, result: PollResult, expected: number | null) {
  const key = `rpm:${zoneId}`;
  const series = (await env.KV.get<RpmPoint[]>(key, "json")) ?? [];
  series.push({ t: Math.floor(result.to.getTime() / 1000), rpm: Math.round(result.rpm), baseline: expected === null ? null : Math.round(expected) });
  await env.KV.put(key, JSON.stringify(series.slice(-180)));
}

export function allowlisted(entries: AllowEntry[], kind: ClusterKind, target: string): boolean {
  for (const e of entries) {
    if (e.kind === "asn" && kind === "asn" && e.value.replace(/^AS/i, "") === target) return true;
    if (e.kind === "ua" && kind === "ua" && target.toLowerCase().includes(e.value.toLowerCase())) return true;
    if (e.kind === "ip" && (kind === "ip" || kind === "ip24")) {
      if (e.value === target) return true;
      if (kind === "ip" && e.value.includes("/") && ipInCidr(target, e.value)) return true;
      if (kind === "ip24" && e.value.includes("/") && e.value === target) return true;
    }
  }
  return false;
}

export function ipInCidr(ip: string, cidr: string): boolean {
  const [net, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  if (!net || !ip.includes(".") || !net.includes(".") || !(bits >= 0 && bits <= 32)) return ip === net;
  const toInt = (s: string) => s.split(".").reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (toInt(ip) & mask) === (toInt(net) & mask);
}

async function handleSpike(
  env: Env,
  zone: ZoneRow,
  settings: Settings,
  result: PollResult,
  expected: number | null,
  spikeId: number,
  jevCred: { value: string; meta: Record<string, unknown> } | null,
) {
  const d = settings.detection;
  const { results: allow } = await env.DB.prepare("SELECT zone_id, kind, value FROM allowlist WHERE zone_id = '' OR zone_id = ?")
    .bind(zone.zone_id).all<AllowEntry>();
  const active = await activeActions(env, zone.zone_id);
  const actioned = new Set(active.map((a) => `${a.kind}|${a.target}`));
  const allowedPaths = allow.filter((a) => a.kind === "path").map((a) => a.value);

  // Verified bots, traffic Cloudflare already blocked, and never-block paths are out of scope.
  const rows = result.rows.filter(
    (r) => !r.verifiedBot && r.securityAction !== "block" && !allowedPaths.some((p) => r.path.startsWith(p)),
  );
  const clusters = buildClusters(rows, result.total, {
    kinds: d.clusterKinds.filter((k) => k !== "ja4" || zone.plan === "enterprise"),
    windowMinutes: d.windowMinutes,
    minRpm: d.minClusterRpm,
    minShare: d.minClusterShare,
    max: d.maxClustersPerTick,
    skip: (kind, target) => allowlisted(allow, kind, target) || actioned.has(`${kind}|${target}`),
  });
  if (!clusters.length) return;

  const jev: JevConfig | null = jevCred
    ? { apiKey: jevCred.value, baseUrl: settings.jev.baseUrl, model: settings.jev.model }
    : null;
  const budget = { callsLeftThisTick: settings.jev.maxCallsPerTick };
  const killed = (await getMeta(env, "kill")) === "1";
  const paused = (zone.paused_until ?? 0) > now();
  // Judging runs in parallel, but applying runs one at a time so the hourly cap is exact.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };

  // Judge a few clusters at a time to stay well inside Jev's rate limits.
  for (let i = 0; i < clusters.length; i += 5) {
    await Promise.all(
      clusters.slice(i, i + 5).map((c) => judgeAndAct(env, zone, settings, c, result, expected, spikeId, jev, budget, { killed, paused }, serial)),
    );
  }
}

async function judgeAndAct(
  env: Env,
  zone: ZoneRow,
  settings: Settings,
  cluster: Cluster,
  result: PollResult,
  expected: number | null,
  spikeId: number,
  jev: JevConfig | null,
  budget: { callsLeftThisTick: number },
  flags: { killed: boolean; paused: boolean },
  serial: <T>(fn: () => Promise<T>) => Promise<T>,
) {
  const state = await buildState(env.SPIKEWARD_SECRET, cluster, {
    description: settings.jev.siteDescription,
    baselineRpm: expected,
    currentRpm: result.rpm,
  });
  const outcome = await judge(env, jev, zone.zone_id, cluster, state, settings, budget, settings.policy.ttlChallenge);
  const policy: PolicyResult =
    outcome.source === "rules"
      ? decideRulesOnly(cluster.kind, cluster.features.rpm, settings.policy, outcome.why)
      : decide(cluster.kind, outcome.verdict, settings.policy, settings.jev.customQuestions);

  const mechanism = policy.action === "allow" || policy.action === "observe" ? null : (policy.action as Mechanism);
  const { decisionId, reason } = await serial(async () => {
    let applied = false;
    let reason = policy.reason;

    if (mechanism) {
      if (zone.mode !== "enforce") reason += " Shadow mode: not applied.";
      else if (flags.killed) reason += " Kill switch is on: not applied.";
      else if (flags.paused || (zone.paused_until ?? 0) > now()) reason += " Enforcement paused by the hourly cap: not applied.";
      else if (await overHourlyCap(env, zone, settings)) reason += " Hourly action cap reached: enforcement paused for an hour.";
      else applied = true;
    }

    const decision = await env.DB.prepare(
      `INSERT INTO decisions (zone_id, spike_id, cluster_key, cluster_kind, target, features, jev_answers, source, action, reason, applied, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    ).bind(
      zone.zone_id,
      spikeId,
      displayKey(cluster),
      cluster.kind,
      cluster.target,
      JSON.stringify(state),
      outcome.source === "rules" ? null : JSON.stringify(outcome.answers),
      outcome.source,
      policy.action,
      reason,
      applied ? 1 : 0,
      now(),
    ).first<{ id: number }>();

    if (applied && mechanism) {
      const prior = await env.DB.prepare("SELECT COUNT(*) AS n FROM actions WHERE zone_id = ? AND target = ? AND applied_at > ?")
        .bind(zone.zone_id, cluster.target, now() - 86400).first<{ n: number }>();
      const ttl = ttlFor(mechanism, prior?.n ?? 0, settings.policy);
      await env.DB.prepare("INSERT INTO actions (decision_id, zone_id, mechanism, kind, target, applied_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(decision!.id, zone.zone_id, mechanism, cluster.kind, cluster.target, now(), now() + ttl).run();
    }
    return { decisionId: decision!.id, reason };
  });

  if (policy.grey && settings.alerts.onGrey) {
    const links = await reviewLinks(env, decisionId);
    await sendAlert(
      settings,
      `Grey-zone verdict on ${zone.name}: ${displayKey(cluster)} at ${Math.round(cluster.features.rpm)} rpm. ${reason}` +
        (links ? `\nKeep it: ${links.approve}\nUndo and always allow: ${links.reject}` : ""),
    );
  }
}

async function overHourlyCap(env: Env, zone: ZoneRow, settings: Settings): Promise<boolean> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM actions WHERE zone_id = ? AND applied_at > ?")
    .bind(zone.zone_id, now() - 3600).first<{ n: number }>();
  if ((row?.n ?? 0) < settings.policy.maxActionsPerHour) return false;
  await env.DB.prepare("UPDATE zones SET paused_until = ? WHERE zone_id = ?").bind(now() + 3600, zone.zone_id).run();
  zone.paused_until = now() + 3600;
  if (settings.alerts.onPause) {
    await sendAlert(settings, `Spikeward paused enforcement on ${zone.name} for an hour: ${settings.policy.maxActionsPerHour} new actions in the last hour. Review the Decisions screen.`);
  }
  return true;
}

/** What people see in the app. The exact target stays in `target`. */
export function displayKey(c: Cluster): string {
  switch (c.kind) {
    case "ip": return `ip:${c.target}`;
    case "ip24": return `range:${c.target}`;
    case "asn": return `asn:${c.target}${c.features.asn_name ? ` (${c.features.asn_name})` : ""}`;
    case "ua": return `ua:${c.target.slice(0, 80) || "(empty)"}`;
    case "ja4": return `ja4:${c.target}`;
  }
}

async function prune(env: Env) {
  const settings = await loadSettings(env);
  const cutoff = now() - settings.retentionDays * 86400;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM decisions WHERE created_at < ?").bind(cutoff),
    env.DB.prepare("DELETE FROM actions WHERE removed_at IS NOT NULL AND removed_at < ?").bind(cutoff),
    env.DB.prepare("DELETE FROM spikes WHERE ended_at IS NOT NULL AND ended_at < ?").bind(cutoff),
  ]);
}

