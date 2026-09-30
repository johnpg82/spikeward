import { z } from "zod";
import type { Env } from "./env";

const clusterKind = z.enum(["ip", "ip24", "asn", "ua", "ja4"]);

export const customQuestion = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
  instructions: z.string().min(5).max(2000),
  yes: z.string().max(500).optional(),
  no: z.string().max(500).optional(),
  threshold: z.number().min(0).max(1).default(0.8),
  action: z.enum(["allow", "observe", "managed_challenge", "block"]),
});
export type CustomQuestion = z.infer<typeof customQuestion>;

// Every setting, with the defaults a user gets by only completing setup.
export const settingsSchema = z.object({
  detection: z
    .object({
      spikeMultiple: z.number().min(1.2).max(100).default(3),
      spikeFloorRpm: z.number().min(10).default(500),
      clusterKinds: z.array(clusterKind).default(["ip", "ip24", "asn", "ua", "ja4"]),
      minClusterRpm: z.number().min(1).default(60),
      minClusterShare: z.number().min(0).max(1).default(0.02),
      maxClustersPerTick: z.number().int().min(1).max(100).default(30),
      windowMinutes: z.number().int().min(1).max(10).default(2),
      lagMinutes: z.number().int().min(0).max(5).default(1),
      calmMinutesToEnd: z.number().int().min(1).max(60).default(5),
    })
    .prefault({}),
  policy: z
    .object({
      allowBelow: z.number().min(0).max(1).default(0.5),
      greyLow: z.number().min(0).max(1).default(0.7),
      greyHigh: z.number().min(0).max(1).default(0.95),
      blockHarm: z.number().min(0).max(1).default(0.6),
      legitAllow: z.number().min(0).max(1).default(0.8),
      ttlChallenge: z.number().int().min(60).default(3600),
      ttlRateLimit: z.number().int().min(60).default(3600),
      ttlBlock: z.number().int().min(60).default(21600),
      maxTtl: z.number().int().min(60).default(7 * 86400),
      maxActionsPerHour: z.number().int().min(1).default(50),
      rateLimitPerMinute: z.number().int().min(1).default(60),
      fallbackIpRpm: z.number().min(1).default(600),
    })
    .prefault({}),
  jev: z
    .object({
      baseUrl: z.string().url().default("https://api.typesafe.ai"),
      model: z.string().min(1).default("jev-latest"),
      siteDescription: z.string().max(500).default("a website"),
      maxCallsPerTick: z.number().int().min(0).max(100).default(30),
      dailyCallCap: z.number().int().min(0).default(5000),
      dailySpendCap: z.number().min(0).default(1),
      pricePerMillionTokens: z.number().min(0).default(0.042),
      customQuestions: z.array(customQuestion).max(10).default([]),
    })
    .prefault({}),
  alerts: z
    .object({
      webhookUrl: z.string().url().or(z.literal("")).default(""),
      onSpike: z.boolean().default(true),
      onGrey: z.boolean().default(true),
      onPause: z.boolean().default(true),
    })
    .prefault({}),
  retentionDays: z.number().int().min(1).max(3650).default(90),
});

export type Settings = z.infer<typeof settingsSchema>;
export const DEFAULTS: Settings = settingsSchema.parse({});

const SECTIONS = ["detection", "policy", "jev", "alerts", "retentionDays"] as const;

/** Global settings, overlaid with any per-zone overrides. */
export async function loadSettings(env: Env, zoneId = ""): Promise<Settings> {
  const { results } = await env.DB.prepare(
    "SELECT zone_id, key, value FROM settings WHERE zone_id = '' OR zone_id = ? ORDER BY zone_id",
  ).bind(zoneId).all<{ zone_id: string; key: string; value: string }>();
  const merged: Record<string, unknown> = {};
  for (const row of results) {
    const value = JSON.parse(row.value);
    const prev = merged[row.key];
    merged[row.key] = isObject(prev) && isObject(value) ? { ...prev, ...value } : value;
  }
  const parsed = settingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : DEFAULTS;
}

/** Stores a partial update; validation runs against the full merged result first. */
export async function saveSettings(env: Env, zoneId: string, patch: Record<string, unknown>): Promise<Settings> {
  const current = await loadSettings(env, zoneId);
  const next: Record<string, unknown> = { ...current };
  for (const key of SECTIONS) {
    if (!(key in patch)) continue;
    const v = patch[key];
    next[key] = isObject(v) && isObject(next[key]) ? { ...(next[key] as object), ...v } : v;
  }
  const validated = settingsSchema.parse(next);
  // A zone stores only its overrides, merged with any it already had.
  const existing: Record<string, unknown> = {};
  if (zoneId) {
    const { results } = await env.DB.prepare("SELECT key, value FROM settings WHERE zone_id = ?")
      .bind(zoneId).all<{ key: string; value: string }>();
    for (const r of results) existing[r.key] = JSON.parse(r.value);
  }
  const stmts = SECTIONS.filter((k) => k in patch).map((k) => {
    const v = patch[k];
    const stored = !zoneId ? validated[k] : isObject(v) && isObject(existing[k]) ? { ...(existing[k] as object), ...v } : v;
    return env.DB.prepare("INSERT OR REPLACE INTO settings (zone_id, key, value) VALUES (?, ?, ?)").bind(
      zoneId,
      k,
      JSON.stringify(stored),
    );
  });
  if (stmts.length) await env.DB.batch(stmts);
  return validated;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
