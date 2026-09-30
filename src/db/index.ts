import type { Env } from "../env";
import { MIGRATIONS } from "./migrations";

let migrated = false;

/** Applies bundled migrations once per isolate. Safe to call on every request and tick. */
export async function migrate(env: Env): Promise<void> {
  if (migrated) return;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)").run();
  const current = Number((await getMeta(env, "schema_version")) ?? "0");
  for (let v = current; v < MIGRATIONS.length; v++) {
    const statements = splitSql(MIGRATIONS[v]!);
    await env.DB.batch([
      ...statements.map((s) => env.DB.prepare(s)),
      env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").bind(String(v + 1)),
    ]);
  }
  if (!(await getMeta(env, "install_id"))) await setMeta(env, "install_id", crypto.randomUUID());
  migrated = true;
}

function splitSql(sql: string): string[] {
  return sql.split(";").map((s) => s.trim()).filter(Boolean);
}

export async function getMeta(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setMeta(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").bind(key, value).run();
}

export const now = () => Math.floor(Date.now() / 1000);

export interface ZoneRow {
  zone_id: string;
  name: string;
  account_id: string;
  plan: string;
  mode: "off" | "shadow" | "enforce";
  rule_ids: string;
  shadow_since: number | null;
  paused_until: number | null;
  locked_until: number | null;
  last_tick_at: number | null;
  last_error: string | null;
  created_at: number;
}

export interface ActionRow {
  id: number;
  decision_id: number | null;
  zone_id: string;
  mechanism: Mechanism;
  kind: ClusterKind;
  target: string;
  applied_at: number;
  expires_at: number;
  removed_at: number | null;
  removed_by: string | null;
}

export type ClusterKind = "ip" | "ip24" | "asn" | "ua" | "ja4";
export type Mechanism = "block" | "managed_challenge" | "rate_limit";

export async function listZones(env: Env): Promise<ZoneRow[]> {
  const { results } = await env.DB.prepare("SELECT * FROM zones ORDER BY name").all<ZoneRow>();
  return results;
}

export async function activeActions(env: Env, zoneId?: string): Promise<ActionRow[]> {
  const t = now();
  const q = zoneId
    ? env.DB.prepare("SELECT * FROM actions WHERE removed_at IS NULL AND expires_at > ? AND zone_id = ? ORDER BY applied_at DESC").bind(t, zoneId)
    : env.DB.prepare("SELECT * FROM actions WHERE removed_at IS NULL AND expires_at > ? ORDER BY applied_at DESC").bind(t);
  return (await q.all<ActionRow>()).results;
}

/** Takes a short lease so overlapping cron runs never process the same zone twice. */
export async function tryLock(env: Env, key: string, seconds: number): Promise<boolean> {
  const t = now();
  if (key.startsWith("zone:")) {
    const res = await env.DB.prepare(
      "UPDATE zones SET locked_until = ? WHERE zone_id = ? AND (locked_until IS NULL OR locked_until < ?)",
    ).bind(t + seconds, key.slice(5), t).run();
    return (res.meta.changes ?? 0) > 0;
  }
  await env.DB.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, '0')").bind(`lock:${key}`).run();
  const res = await env.DB.prepare("UPDATE meta SET value = ? WHERE key = ? AND CAST(value AS INTEGER) < ?")
    .bind(String(t + seconds), `lock:${key}`, t).run();
  return (res.meta.changes ?? 0) > 0;
}

export async function unlock(env: Env, key: string): Promise<void> {
  if (key.startsWith("zone:")) {
    await env.DB.prepare("UPDATE zones SET locked_until = NULL WHERE zone_id = ?").bind(key.slice(5)).run();
  } else {
    await env.DB.prepare("UPDATE meta SET value = '0' WHERE key = ?").bind(`lock:${key}`).run();
  }
}
