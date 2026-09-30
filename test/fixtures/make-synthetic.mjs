// Generates test/fixtures/spikes/synthetic-mixed.json: a GraphQL Analytics response shaped
// exactly like Cloudflare's, for a two-minute window during a mixed bot spike.
// Synthetic, not recorded. Add recorded spikes with `npm run record` (see docs/testing.md).
import { writeFileSync } from "node:fs";

const groups = [];
const row = (count, d) =>
  groups.push({
    count,
    dimensions: {
      clientIP: d.ip, clientAsn: d.asn, clientASNDescription: d.asnName, clientCountryName: d.country ?? "US",
      userAgent: d.ua, clientRequestPath: d.path, clientRequestQuery: d.query ?? "", clientRequestHTTPMethodName: d.method ?? "GET",
      edgeResponseStatus: d.status ?? 200, edgeResponseContentTypeName: d.ct ?? "html", verifiedBotCategory: d.verified ?? "",
      securityAction: d.action ?? "unknown",
    },
  });

// 1. Content scraper spread over 60 DigitalOcean IPs in 60 different /24s: only the network explains it.
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
for (let i = 0; i < 60; i++) {
  const ip = `159.203.${i + 10}.${(i * 7) % 250 + 2}`;
  for (let p = 0; p < 8; p++) row(9, { ip, asn: 14061, asnName: "DIGITALOCEAN-ASN", ua: CHROME, path: `/lectures/${1000 + i * 8 + p}`, country: "NL" });
  row(8, { ip, asn: 14061, asnName: "DIGITALOCEAN-ASN", ua: CHROME, path: `/lectures/${99000 + i}`, status: 404, country: "NL" });
}

// 2. Credential stuffing from one IP.
row(1200, { ip: "203.0.113.50", asn: 9009, asnName: "M247", ua: "python-requests/2.32.3", path: "/login", method: "POST", status: 401, country: "RO" });
row(300, { ip: "203.0.113.50", asn: 9009, asnName: "M247", ua: "python-requests/2.32.3", path: "/login", method: "POST", status: 200, country: "RO" });

// 3. Vulnerability scanner from one IP, with raw attack strings that must never reach Jev.
const scanner = { ip: "198.51.100.7", asn: 16276, asnName: "OVH", ua: "Mozilla/5.0 zgrab/0.x", country: "FR" };
row(120, { ...scanner, path: "/search", query: "q=1%27%20UNION%20SELECT%20password%20FROM%20users--", status: 403 });
row(100, { ...scanner, path: "/../../etc/passwd", status: 400 });
row(80, { ...scanner, path: "/.env", status: 404 });

// 4. Googlebot: verified, always excluded.
row(400, { ip: "66.249.66.1", asn: 15169, asnName: "GOOGLE", ua: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", path: "/lectures/1", verified: "Search Engine Crawler" });

// 5. Uptime monitor on the never-block list.
row(200, { ip: "192.0.2.10", asn: 396982, asnName: "GOOGLE-CLOUD-PLATFORM", ua: "UptimeMonitor/1.0", path: "/health", ct: "json" });

// 6. A real human burst after a newsletter: many residential IPs, pages plus assets.
const isps = [[7922, "COMCAST-7922"], [701, "UUNET"], [3320, "DTAG"]];
const uas = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0",
  CHROME,
];
for (let i = 0; i < 300; i++) {
  const [asn, asnName] = isps[i % 3];
  const ip = `${[73, 71, 87][i % 3]}.${(i * 13) % 250}.${(i * 7) % 250}.${(i % 250) + 1}`;
  const ua = uas[i % uas.length];
  row(1, { ip, asn, asnName, ua, path: "/blog/launch", country: i % 3 === 2 ? "DE" : "US" });
  row(1, { ip, asn, asnName, ua, path: "/assets/app.css", ct: "css", country: i % 3 === 2 ? "DE" : "US" });
  row(1, { ip, asn, asnName, ua, path: "/assets/app.js", ct: "javascript", country: i % 3 === 2 ? "DE" : "US" });
  row(1, { ip, asn, asnName, ua, path: "/images/hero.webp", ct: "webp", country: i % 3 === 2 ? "DE" : "US" });
}

groups.sort((a, b) => b.count - a.count);
const total = groups.reduce((a, g) => a + g.count, 0);
const totals = [
  { count: Math.floor(total / 2), dimensions: { datetimeMinute: "2026-09-29T11:41:00Z" } },
  { count: total - Math.floor(total / 2), dimensions: { datetimeMinute: "2026-09-29T11:42:00Z" } },
];
writeFileSync(
  new URL("./spikes/synthetic-mixed.json", import.meta.url),
  JSON.stringify({ description: "Synthetic mixed spike: scraper network, credential stuffer, scanner, Googlebot, allowlisted monitor, human burst", data: { viewer: { zones: [{ totals, groups }] } } }, null, 1),
);
console.log(`rows=${groups.length} total=${total} rpm=${total / 2}`);
