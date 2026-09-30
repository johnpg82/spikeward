import type { Cloudflare } from "../cf/client";
import type { TrafficRow } from "./cluster";

interface GroupResult {
  count: number;
  dimensions: Record<string, string | number | null>;
}

interface PollData {
  viewer: { zones: { totals: GroupResult[]; groups: GroupResult[] }[] };
}

/**
 * Every dimension Spikeward can use. Which ones a zone may read depends on its plan: Free
 * zones can't read ASN, query strings, JA4, or bot score, so those signals are simply absent.
 */
export const WANTED_FIELDS = [
  "clientIP",
  "clientCountryName",
  "userAgent",
  "clientRequestPath",
  "clientRequestHTTPMethodName",
  "clientRequestHTTPProtocol",
  "edgeResponseStatus",
  "edgeResponseContentTypeName",
  "verifiedBotCategory",
  "securityAction",
  "clientAsn",
  "clientASNDescription",
  "clientRequestQuery",
  "ja4",
  "botScore",
] as const;

/** What a Free zone could read when checked in September 2026; used if the settings lookup fails. */
export const FREE_FIELDS: string[] = WANTED_FIELDS.slice(0, 10);

/** Asks Cloudflare which fields this zone may query in the adaptive requests dataset. */
export async function availableFields(cf: Cloudflare, zoneId: string): Promise<string[]> {
  const data = await cf.graphql<{
    viewer: { zones: { settings: { httpRequestsAdaptiveGroups: { enabled: boolean; availableFields: string[] } } }[] };
  }>(
    `query SpikewardFields($zone: String!) { viewer { zones(filter: { zoneTag: $zone }) { settings { httpRequestsAdaptiveGroups { enabled availableFields } } } } }`,
    { zone: zoneId },
  );
  const node = data.viewer.zones[0]?.settings.httpRequestsAdaptiveGroups;
  if (!node?.enabled) throw new Error("This zone can't read the HTTP requests analytics dataset.");
  const dims = new Set(node.availableFields.filter((f) => f.startsWith("dimensions_")).map((f) => f.slice(11)));
  return [...WANTED_FIELDS.filter((f) => dims.has(f)), ...(dims.has("requestSource") ? ["requestSource"] : [])];
}

function query(fields: string[]) {
  const dims = fields.filter((f) => f !== "requestSource").join(" ");
  // Only count visitor traffic when the zone can filter on it; otherwise count everything.
  const source = fields.includes("requestSource") ? `, requestSource: "eyeball"` : "";
  return `query Spikeward($zone: String!, $from: Time!, $to: Time!, $limit: Int!) {
  viewer {
    zones(filter: { zoneTag: $zone }) {
      totals: httpRequestsAdaptiveGroups(limit: 30, filter: { datetime_geq: $from, datetime_lt: $to${source} }, orderBy: [datetimeMinute_ASC]) {
        count
        dimensions { datetimeMinute }
      }
      groups: httpRequestsAdaptiveGroups(limit: $limit, filter: { datetime_geq: $from, datetime_lt: $to${source} }, orderBy: [count_DESC]) {
        count
        dimensions { ${dims} }
      }
    }
  }
}`;
}

export interface PollResult {
  rpm: number;
  total: number;
  rows: TrafficRow[];
  from: Date;
  to: Date;
}

/**
 * Reads the last complete minutes of traffic. `lagMinutes` skips the newest minute, which the
 * analytics pipeline is usually still filling in.
 */
export async function poll(
  cf: Cloudflare,
  zoneId: string,
  opts: { windowMinutes: number; lagMinutes: number; fields: string[]; limit?: number; at?: Date },
): Promise<PollResult> {
  const at = opts.at ?? new Date();
  const to = new Date(Math.floor(at.getTime() / 60000) * 60000 - opts.lagMinutes * 60000);
  const from = new Date(to.getTime() - opts.windowMinutes * 60000);
  const vars = { zone: zoneId, from: from.toISOString(), to: to.toISOString(), limit: opts.limit ?? 5000 };
  const data = await cf.graphql<PollData>(query(opts.fields), vars);
  const zone = data.viewer.zones[0];
  const total = (zone?.totals ?? []).reduce((a, g) => a + g.count, 0);
  return { rpm: total / opts.windowMinutes, total, rows: (zone?.groups ?? []).map(toRow), from, to };
}

function toRow(g: GroupResult): TrafficRow {
  const d = g.dimensions;
  return {
    count: g.count,
    ip: String(d.clientIP ?? ""),
    asn: Number(d.clientAsn ?? 0),
    asnName: String(d.clientASNDescription ?? ""),
    country: String(d.clientCountryName ?? ""),
    ua: String(d.userAgent ?? ""),
    path: String(d.clientRequestPath ?? "/"),
    query: String(d.clientRequestQuery ?? ""),
    method: String(d.clientRequestHTTPMethodName ?? ""),
    protocol: d.clientRequestHTTPProtocol ? String(d.clientRequestHTTPProtocol) : undefined,
    status: Number(d.edgeResponseStatus ?? 0),
    contentType: String(d.edgeResponseContentTypeName ?? ""),
    verifiedBot: String(d.verifiedBotCategory ?? ""),
    securityAction: String(d.securityAction ?? ""),
    ja4: d.ja4 ? String(d.ja4) : undefined,
    botScore: typeof d.botScore === "number" ? d.botScore : undefined,
  };
}
