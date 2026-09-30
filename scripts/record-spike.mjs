// Records a real spike from Cloudflare's GraphQL Analytics API as a replay fixture, anonymized
// so it is safe to commit to a public repo: IPs are remapped consistently into 10.0.0.0/8
// (keeping which IPs share a /24), and query values are dropped. ASNs and user agents are kept.
//
//   CLOUDFLARE_API_TOKEN=... node scripts/record-spike.mjs --zone <zone id> --from 2026-09-29T11:41:00Z [--minutes 2] --name my-spike
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: a } = parseArgs({ options: { zone: { type: "string" }, from: { type: "string" }, minutes: { type: "string", default: "2" }, name: { type: "string" } } });
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token || !a.zone || !a.from || !a.name) {
  console.error("Usage: CLOUDFLARE_API_TOKEN=... node scripts/record-spike.mjs --zone <id> --from <ISO time> [--minutes 2] --name <fixture name>");
  process.exit(1);
}
const from = new Date(a.from);
const to = new Date(from.getTime() + Number(a.minutes) * 60000);

const query = `query ($zone: String!, $from: Time!, $to: Time!) { viewer { zones(filter: { zoneTag: $zone }) {
  totals: httpRequestsAdaptiveGroups(limit: 30, filter: { datetime_geq: $from, datetime_lt: $to, requestSource: "eyeball" }, orderBy: [datetimeMinute_ASC]) { count dimensions { datetimeMinute } }
  groups: httpRequestsAdaptiveGroups(limit: 5000, filter: { datetime_geq: $from, datetime_lt: $to, requestSource: "eyeball" }, orderBy: [count_DESC]) {
    count dimensions { clientIP clientAsn clientASNDescription clientCountryName userAgent clientRequestPath clientRequestQuery
      clientRequestHTTPMethodName edgeResponseStatus edgeResponseContentTypeName verifiedBotCategory securityAction } } } } }`;

const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query, variables: { zone: a.zone, from: from.toISOString(), to: to.toISOString() } }),
});
const json = await res.json();
if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));

const salt = createHash("sha256").update(String(Math.random())).digest();
const h = (s) => createHash("sha256").update(salt).update(s).digest();
const fakeIp = (ip) => {
  if (!ip) return ip;
  const net = ip.includes(".") ? ip.split(".").slice(0, 3).join(".") : ip.split(":").slice(0, 3).join(":");
  const n = h(net);
  const host = h(ip)[0] % 254 + 1;
  return `10.${n[0]}.${n[1]}.${host}`;
};
const stripQuery = (q) => (q ? q.replace(/^\?/, "").split("&").map((p) => `${p.split("=")[0]}=x`).join("&") : q);

const zone = json.data.viewer.zones[0];
for (const g of zone.groups) {
  g.dimensions.clientIP = fakeIp(g.dimensions.clientIP);
  g.dimensions.clientRequestQuery = stripQuery(g.dimensions.clientRequestQuery);
}
const out = new URL(`../test/fixtures/spikes/${a.name}.json`, import.meta.url);
writeFileSync(out, JSON.stringify({ description: `Recorded ${from.toISOString()} for ${a.minutes} min, anonymized`, data: json.data }, null, 1));
console.log(`Wrote ${out.pathname}: ${zone.groups.length} groups, ${zone.totals.reduce((s, t) => s + t.count, 0)} requests`);
