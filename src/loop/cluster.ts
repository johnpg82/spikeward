import type { ClusterKind } from "../db";
import { attackFlags, hitsLogin, normalizePath, normalizeQuery, type AttackFlags } from "./sanitize";

/** One grouped row from the analytics API. `count` is Cloudflare's sampling-adjusted estimate. */
export interface TrafficRow {
  count: number;
  ip: string;
  asn: number;
  asnName: string;
  country: string;
  ua: string;
  path: string;
  query: string;
  method: string;
  protocol?: string;
  status: number;
  contentType: string;
  verifiedBot: string;
  securityAction: string;
  ja4?: string;
  botScore?: number;
}

export interface ClusterFeatures {
  rpm: number;
  share_of_traffic: number;
  distinct_ips: number;
  distinct_paths: number;
  distinct_user_agents: number;
  top_paths: { path: string; share: number }[];
  status_mix: Record<string, number>;
  rate_4xx: number;
  rate_403: number;
  asset_to_page_ratio: number | null;
  method_mix: Record<string, number>;
  http_protocol_mix: Record<string, number> | null;
  countries: { country: string; share: number }[];
  user_agents: string[];
  asn: number | null;
  asn_name: string | null;
  hosting_asn: boolean;
  login_share: number;
  already_mitigated_share: number;
  avg_bot_score: number | null;
  flags: AttackFlags;
}

export interface Cluster {
  kind: ClusterKind;
  /** Exact target used in WAF rules (an IP, CIDR, ASN number, user agent, or JA4). Never sent to Jev for IP kinds. */
  target: string;
  count: number;
  features: ClusterFeatures;
}

// Narrowest first. User agents come last: an ordinary browser user agent is shared by
// millions of real people, so it is only used when nothing narrower explains the traffic.
const ORDER: ClusterKind[] = ["ip", "ip24", "ja4", "asn", "ua"];

export function targetFor(kind: ClusterKind, row: TrafficRow): string | null {
  switch (kind) {
    case "ip": return row.ip || null;
    case "ip24": return row.ip ? cidrFor(row.ip) : null;
    case "asn": return row.asn ? String(row.asn) : null;
    case "ua": return row.ua;
    case "ja4": return row.ja4 || null;
  }
}

export function cidrFor(ip: string): string | null {
  if (ip.includes(".")) {
    const p = ip.split(".");
    return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.0/24` : null;
  }
  const full = expandIPv6(ip);
  return full ? `${full.slice(0, 3).join(":")}::/48` : null;
}

export function expandIPv6(ip: string): string[] | null {
  const [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  if (tail === undefined && h.length !== 8) return null;
  const fill = 8 - h.length - t.length;
  if (fill < 0) return null;
  return [...h, ...Array(fill).fill("0"), ...t].map((x) => x.toLowerCase().replace(/^0+(?=.)/, ""));
}

const HOSTING_ASNS = new Set([
  16509, 14618, 8987, 15169, 396982, 19527, 8075, 14061, 16276, 24940, 63949, 20473, 45102, 132203, 31898, 51167,
  60781, 9009, 12876, 36352, 40021, 53667, 62567, 212238, 202425, 49981, 206264, 135377, 55286, 399629,
]);
const HOSTING_NAME = /(hosting|host|cloud|server|data ?cent(er|re)|vps|colo|amazon|google|microsoft|azure|digitalocean|ovh|hetzner|linode|akamai|alibaba|tencent|oracle|vultr|choopa|contabo|leaseweb|scaleway|m247|datacamp|proxy)/i;

export function isHostingAsn(asn: number, name: string): boolean {
  return HOSTING_ASNS.has(asn) || HOSTING_NAME.test(name);
}

export interface ClusterOptions {
  kinds: ClusterKind[];
  windowMinutes: number;
  minRpm: number;
  minShare: number;
  max: number;
  /** Targets already actioned or allowlisted: their traffic counts as handled but they aren't judged again. */
  skip?: (kind: ClusterKind, target: string) => boolean;
}

export function buildClusters(rows: TrafficRow[], total: number, opts: ClusterOptions): Cluster[] {
  const covered = new Uint8Array(rows.length);
  const denom = Math.max(total, 1);
  const out: Cluster[] = [];

  for (const kind of ORDER) {
    if (!opts.kinds.includes(kind)) continue;
    const groups = new Map<string, number[]>();
    rows.forEach((row, i) => {
      const t = targetFor(kind, row);
      if (t === null) return;
      const g = groups.get(t);
      if (g) g.push(i);
      else groups.set(t, [i]);
    });

    const ranked = [...groups.entries()]
      .map(([target, idx]) => ({ target, idx, count: sum(idx.map((i) => rows[i]!.count)) }))
      .filter((g) => g.count / opts.windowMinutes >= opts.minRpm && g.count / denom >= opts.minShare)
      .sort((a, b) => b.count - a.count);

    for (const g of ranked) {
      if (opts.skip?.(kind, g.target)) {
        for (const i of g.idx) covered[i] = 1;
        continue;
      }
      const uncovered = sum(g.idx.filter((i) => !covered[i]).map((i) => rows[i]!.count));
      // Only judge a broader cluster when most of its traffic isn't already explained by a narrower one.
      if (uncovered / g.count < 0.5 || uncovered / opts.windowMinutes < opts.minRpm) continue;
      for (const i of g.idx) covered[i] = 1;
      out.push({ kind, target: g.target, count: g.count, features: features(g.idx.map((i) => rows[i]!), g.count, denom, opts.windowMinutes) });
      if (out.length >= opts.max) return out;
    }
  }
  return out;
}

const ASSET = /(css|javascript|js|image|png|jpe?g|gif|webp|svg|avif|ico|font|woff2?|ttf|otf)/i;

export function features(rows: TrafficRow[], count: number, total: number, windowMinutes: number): ClusterFeatures {
  const by = <K extends string | number>(f: (r: TrafficRow) => K) => {
    const m = new Map<K, number>();
    for (const r of rows) m.set(f(r), (m.get(f(r)) ?? 0) + r.count);
    return m;
  };
  const share = (n: number) => round(n / Math.max(count, 1));
  const topShares = <K extends string | number>(m: Map<K, number>, n: number) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

  const paths = by((r) => normalizePath(r.path) + normalizeQuery(r.query));
  const statuses = by((r) => r.status);
  const statusMix: Record<string, number> = {};
  for (const [s, n] of statuses) {
    const cls = `${Math.floor(s / 100)}xx`;
    statusMix[cls] = round((statusMix[cls] ?? 0) + n / Math.max(count, 1));
  }
  const pages = sum(rows.filter((r) => /html/i.test(r.contentType)).map((r) => r.count));
  const assets = sum(rows.filter((r) => ASSET.test(r.contentType)).map((r) => r.count));
  const asns = topShares(by((r) => r.asn), 1)[0];
  const asnName = rows.find((r) => r.asn === asns?.[0])?.asnName ?? "";
  const flags = attackFlags(...new Set(rows.map((r) => `${r.path}?${r.query}`)));
  const scored = rows.filter((r) => typeof r.botScore === "number" && r.botScore > 0);

  return {
    rpm: round(count / windowMinutes, 1),
    share_of_traffic: round(count / total),
    distinct_ips: new Set(rows.map((r) => r.ip)).size,
    distinct_paths: paths.size,
    distinct_user_agents: new Set(rows.map((r) => r.ua)).size,
    top_paths: topShares(paths, 5).map(([path, n]) => ({ path, share: share(n) })),
    status_mix: statusMix,
    rate_4xx: share(sum(rows.filter((r) => r.status >= 400 && r.status < 500).map((r) => r.count))),
    rate_403: share(sum(rows.filter((r) => r.status === 403).map((r) => r.count))),
    asset_to_page_ratio: pages > 0 ? round(assets / pages) : null,
    method_mix: Object.fromEntries(topShares(by((r) => r.method), 4).map(([m, n]) => [m, share(n)])),
    http_protocol_mix: rows.some((r) => r.protocol)
      ? Object.fromEntries(topShares(by((r) => r.protocol ?? "unknown"), 4).map(([p, n]) => [p, share(n)]))
      : null,
    countries: topShares(by((r) => r.country), 5).map(([country, n]) => ({ country, share: share(n) })),
    user_agents: topShares(by((r) => r.ua), 3).map(([ua]) => (ua ? ua.slice(0, 200) : "(empty)")),
    asn: asns ? Number(asns[0]) || null : null,
    asn_name: asnName || null,
    hosting_asn: asns ? isHostingAsn(Number(asns[0]), asnName) : false,
    login_share: share(sum(rows.filter((r) => hitsLogin(r.path)).map((r) => r.count))),
    already_mitigated_share: share(sum(rows.filter((r) => r.securityAction && r.securityAction !== "unknown").map((r) => r.count))),
    avg_bot_score: scored.length ? round(sum(scored.map((r) => r.botScore! * r.count)) / sum(scored.map((r) => r.count)), 1) : null,
    flags,
  };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
