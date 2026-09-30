import type { Env } from "../env";
import { Cloudflare, type Ruleset, type RulesetRule } from "../cf/client";
import { loadCredential } from "../credentials";
import { activeActions, getMeta, listZones, now, setMeta, tryLock, unlock, type ActionRow, type ZoneRow } from "../db";
import { loadSettings } from "../settings";

// Spikeward only ever touches objects it created: one account IP list and rules with these refs.
export const LIST_NAME = "spikeward_blocks";
const CUSTOM_PHASE = "http_request_firewall_custom";
const RATELIMIT_PHASE = "http_ratelimit";
const PLACEHOLDER = '(http.host eq "spikeward.invalid")';
const MAX_EXPRESSION = 3800;

export interface RuleIds {
  customRuleset?: string;
  block?: string;
  challenge?: string;
  ratelimitRuleset?: string;
  ja4?: string;
}

const blockRule = (enabled: boolean): RulesetRule => ({
  ref: "spikeward_block",
  description: "spikeward: block (managed by Spikeward; edits are overwritten)",
  action: "block",
  expression: `(ip.src in $${LIST_NAME})`,
  enabled,
});

const challengeRule = (expression: string, enabled: boolean): RulesetRule => ({
  ref: "spikeward_challenge",
  description: "spikeward: managed challenge (managed by Spikeward; edits are overwritten)",
  action: "managed_challenge",
  expression,
  enabled,
});

const ja4Rule = (expression: string, enabled: boolean, perMinute: number): RulesetRule => ({
  ref: "spikeward_ja4",
  description: "spikeward: rate limit by TLS fingerprint (managed by Spikeward; edits are overwritten)",
  action: "block",
  expression,
  enabled,
  ratelimit: {
    characteristics: ["cf.colo.id", "cf.bot_management.ja4"],
    period: 60,
    requests_per_period: perMinute,
    mitigation_timeout: 600,
  },
});

const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * Builds the challenge rule from active challenge actions, newest first, staying under the
 * expression size limit. Returns the ids that made it in.
 */
export function challengeExpression(actions: ActionRow[]): { expression: string | null; included: number[] } {
  const ips: string[] = [];
  const asns: string[] = [];
  const uas: string[] = [];
  const included: number[] = [];
  const build = () => {
    const parts: string[] = [];
    if (ips.length) parts.push(`(ip.src in {${ips.join(" ")}})`);
    if (asns.length) parts.push(`(ip.src.asnum in {${asns.join(" ")}})`);
    for (const ua of uas) parts.push(`(http.user_agent eq ${quote(ua)})`);
    return parts.join(" or ");
  };
  for (const a of actions) {
    if (a.mechanism !== "managed_challenge") continue;
    const list = a.kind === "ip" || a.kind === "ip24" ? ips : a.kind === "asn" ? asns : a.kind === "ua" ? uas : null;
    if (!list || list.includes(a.target)) continue;
    list.push(a.target);
    if (build().length > MAX_EXPRESSION) {
      list.pop();
      continue;
    }
    included.push(a.id);
  }
  const expression = build();
  return { expression: expression || null, included };
}

export function ja4Expression(actions: ActionRow[]): string | null {
  const fps = [...new Set(actions.filter((a) => a.mechanism === "rate_limit" && a.kind === "ja4").map((a) => a.target))];
  return fps.length ? `(cf.bot_management.ja4 in {${fps.map(quote).join(" ")}})` : null;
}

export async function cloudflareClient(env: Env): Promise<Cloudflare | null> {
  const cred = await loadCredential(env, "cloudflare");
  return cred ? new Cloudflare(cred.value) : null;
}

async function ensureList(env: Env, cf: Cloudflare, accountId: string): Promise<string> {
  const key = `list:${accountId}`;
  const known = await getMeta(env, key);
  if (known) return known;
  const list =
    (await cf.findList(accountId, LIST_NAME)) ??
    (await cf.createIpList(accountId, LIST_NAME, "Spikeward: short-lived blocks. Managed automatically; entries expire on their own."));
  await setMeta(env, key, list.id);
  return list.id;
}

/** Creates the list and this zone's rules, disabled. Reuses rules left by an earlier install. */
export async function provisionZone(env: Env, cf: Cloudflare, zone: ZoneRow): Promise<RuleIds> {
  await ensureList(env, cf, zone.account_id);
  const ids: RuleIds = {};
  const entry = await cf.getEntrypoint(zone.zone_id, CUSTOM_PHASE);
  for (const rule of [blockRule(false), challengeRule(PLACEHOLDER, false)]) {
    const existing = entry?.rules?.find((r) => r.ref === rule.ref);
    const created = existing?.id ? { rulesetId: entry!.id, rule: existing } : await cf.addRule(zone.zone_id, CUSTOM_PHASE, rule);
    ids.customRuleset = created.rulesetId;
    if (rule.ref === "spikeward_block") ids.block = created.rule.id;
    else ids.challenge = created.rule.id;
  }
  await saveRuleIds(env, zone.zone_id, ids);
  return ids;
}

export async function deprovisionZone(env: Env, cf: Cloudflare, zone: ZoneRow): Promise<void> {
  const ids = parseRuleIds(zone);
  if (ids.customRuleset) {
    if (ids.block) await cf.deleteRule(zone.zone_id, ids.customRuleset, ids.block);
    if (ids.challenge) await cf.deleteRule(zone.zone_id, ids.customRuleset, ids.challenge);
  }
  if (ids.ratelimitRuleset && ids.ja4) await cf.deleteRule(zone.zone_id, ids.ratelimitRuleset, ids.ja4);
  await env.DB.prepare("UPDATE actions SET removed_at = ?, removed_by = 'zone removed' WHERE zone_id = ? AND removed_at IS NULL")
    .bind(now(), zone.zone_id).run();
}

export function parseRuleIds(zone: ZoneRow): RuleIds {
  try {
    return JSON.parse(zone.rule_ids) as RuleIds;
  } catch {
    return {};
  }
}

async function saveRuleIds(env: Env, zoneId: string, ids: RuleIds) {
  await env.DB.prepare("UPDATE zones SET rule_ids = ? WHERE zone_id = ?").bind(JSON.stringify(ids), zoneId).run();
}

/** Marks expired actions as removed. The sync below then takes them out of Cloudflare. */
export async function expireActions(env: Env): Promise<number> {
  const t = now();
  const res = await env.DB.prepare("UPDATE actions SET removed_at = expires_at, removed_by = 'expired' WHERE removed_at IS NULL AND expires_at <= ?")
    .bind(t).run();
  return res.meta.changes ?? 0;
}

/**
 * Janitor and reconciler: makes Cloudflare match D1 on every tick, so a failed call never
 * leaves an orphan block and a hand-edited Spikeward rule is put back.
 */
export async function sync(env: Env): Promise<void> {
  if (!(await tryLock(env, "sync", 50))) return;
  try {
    await expireActions(env);
    const cf = await cloudflareClient(env);
    if (!cf) return;
    const killed = (await getMeta(env, "kill")) === "1";
    const zones = (await listZones(env)).filter((z) => z.mode !== "off");
    const actions = await activeActions(env);
    const enforcing = new Set(zones.filter((z) => z.mode === "enforce" && !killed).map((z) => z.zone_id));

    for (const accountId of new Set(zones.map((z) => z.account_id))) {
      try {
        await syncList(env, cf, accountId, zones, actions.filter((a) => enforcing.has(a.zone_id)));
      } catch (e) {
        console.error("list sync failed", accountId, e);
      }
    }
    for (const zone of zones) {
      try {
        await syncZoneRules(env, cf, zone, actions.filter((a) => a.zone_id === zone.zone_id), enforcing.has(zone.zone_id));
        if (zone.last_error?.startsWith("Rules:")) {
          await env.DB.prepare("UPDATE zones SET last_error = NULL WHERE zone_id = ?").bind(zone.zone_id).run();
        }
      } catch (e) {
        await env.DB.prepare("UPDATE zones SET last_error = ? WHERE zone_id = ?").bind(`Rules: ${(e as Error).message}`, zone.zone_id).run();
      }
    }
  } finally {
    await unlock(env, "sync");
  }
}

async function syncList(env: Env, cf: Cloudflare, accountId: string, zones: ZoneRow[], actions: ActionRow[]) {
  const listId = await ensureList(env, cf, accountId);
  const zoneIds = new Set(zones.filter((z) => z.account_id === accountId).map((z) => z.zone_id));
  const names = new Map(zones.map((z) => [z.zone_id, z.name]));
  const desired = new Map<string, ActionRow>();
  for (const a of actions) {
    if (a.mechanism === "block" && a.kind === "ip" && zoneIds.has(a.zone_id) && !desired.has(a.target)) desired.set(a.target, a);
  }
  const items = await cf.listItems(accountId, listId);
  const present = new Set(items.map((i) => i.ip));
  const toDelete = items.filter((i) => !i.ip || !desired.has(i.ip)).map((i) => i.id);
  const toAdd = [...desired.values()]
    .filter((a) => !present.has(a.target))
    .map((a) => ({
      ip: a.target,
      comment: `spikeward ${names.get(a.zone_id) ?? a.zone_id} action ${a.id} until ${new Date(a.expires_at * 1000).toISOString()}`,
    }));
  await cf.deleteListItems(accountId, listId, toDelete);
  await cf.addListItems(accountId, listId, toAdd);
}

async function syncZoneRules(env: Env, cf: Cloudflare, zone: ZoneRow, actions: ActionRow[], enforce: boolean) {
  const ids = parseRuleIds(zone);
  const settings = await loadSettings(env, zone.zone_id);
  const { expression } = challengeExpression(actions);

  const custom = await cf.getEntrypoint(zone.zone_id, CUSTOM_PHASE);
  const wanted: RulesetRule[] = [blockRule(enforce), challengeRule(expression ?? PLACEHOLDER, enforce && !!expression)];
  let changed = false;
  for (const rule of wanted) {
    const idKey = rule.ref === "spikeward_block" ? "block" : "challenge";
    const current = findRule(custom, ids[idKey], rule.ref!);
    if (!current || !custom) {
      const created = await cf.addRule(zone.zone_id, CUSTOM_PHASE, rule);
      ids.customRuleset = created.rulesetId;
      ids[idKey] = created.rule.id;
      changed = true;
    } else {
      if (ids[idKey] !== current.id || ids.customRuleset !== custom.id) {
        ids[idKey] = current.id;
        ids.customRuleset = custom.id;
        changed = true;
      }
      if (differs(current, rule)) await cf.updateRule(zone.zone_id, custom.id, current.id!, rule);
    }
  }

  // JA4 rate limiting needs Enterprise with Bot Management; only created once it's first needed.
  const ja4 = ja4Expression(actions);
  if (zone.plan === "enterprise" && (ja4 || ids.ja4)) {
    const rl = await cf.getEntrypoint(zone.zone_id, RATELIMIT_PHASE);
    const rule = ja4Rule(ja4 ?? PLACEHOLDER, enforce && !!ja4, settings.policy.rateLimitPerMinute);
    const current = findRule(rl, ids.ja4, rule.ref!);
    if (!current || !rl) {
      const created = await cf.addRule(zone.zone_id, RATELIMIT_PHASE, rule);
      ids.ratelimitRuleset = created.rulesetId;
      ids.ja4 = created.rule.id;
      changed = true;
    } else if (differs(current, rule)) {
      await cf.updateRule(zone.zone_id, rl.id, current.id!, rule);
    }
  }
  if (changed) await saveRuleIds(env, zone.zone_id, ids);
}

function findRule(ruleset: Ruleset | undefined, id: string | undefined, ref: string): RulesetRule | undefined {
  return ruleset?.rules?.find((r) => (id && r.id === id) || r.ref === ref);
}

function differs(current: RulesetRule, wanted: RulesetRule): boolean {
  return (
    current.expression !== wanted.expression ||
    current.enabled !== wanted.enabled ||
    current.action !== wanted.action ||
    current.description !== wanted.description ||
    (wanted.ratelimit !== undefined && JSON.stringify(pick(current.ratelimit, wanted.ratelimit)) !== JSON.stringify(wanted.ratelimit))
  );
}

function pick(obj: Record<string, unknown> | undefined, like: Record<string, unknown>) {
  return Object.fromEntries(Object.keys(like).map((k) => [k, obj?.[k]]));
}
