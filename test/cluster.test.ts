import { describe, expect, it } from "vitest";
import { buildClusters, cidrFor, expandIPv6, type TrafficRow } from "../src/loop/cluster";
import fixture from "./fixtures/spikes/synthetic-mixed.json";

const base: TrafficRow = {
  count: 1, ip: "", asn: 0, asnName: "", country: "US", ua: "ua", path: "/", query: "", method: "GET",
  status: 200, contentType: "html", verifiedBot: "", securityAction: "",
};

describe("clusters", () => {
  it("computes ranges for IPv4 and IPv6", () => {
    expect(cidrFor("203.0.113.50")).toBe("203.0.113.0/24");
    expect(cidrFor("2001:db8:1234:5678::1")).toBe("2001:db8:1234::/48");
    expect(expandIPv6("::1")).toEqual(["0", "0", "0", "0", "0", "0", "0", "1"]);
  });

  it("prefers the narrowest target and skips broader clusters it already explains", () => {
    const rows: TrafficRow[] = [
      { ...base, count: 900, ip: "203.0.113.50", asn: 9009, asnName: "M247" },
      { ...base, count: 20, ip: "203.0.113.51", asn: 9009, asnName: "M247" },
    ];
    const clusters = buildClusters(rows, 1000, { kinds: ["ip", "ip24", "asn", "ua"], windowMinutes: 1, minRpm: 60, minShare: 0.02, max: 10 });
    expect(clusters.map((c) => `${c.kind}:${c.target}`)).toEqual(["ip:203.0.113.50"]);
  });

  it("finds the scraper network and the single-IP attackers in the synthetic spike", () => {
    const groups = fixture.data.viewer.zones[0]!.groups;
    const rows: TrafficRow[] = groups.map((g) => ({
      count: g.count, ip: g.dimensions.clientIP, asn: g.dimensions.clientAsn, asnName: g.dimensions.clientASNDescription,
      country: g.dimensions.clientCountryName, ua: g.dimensions.userAgent, path: g.dimensions.clientRequestPath,
      query: g.dimensions.clientRequestQuery, method: g.dimensions.clientRequestHTTPMethodName, status: g.dimensions.edgeResponseStatus,
      contentType: g.dimensions.edgeResponseContentTypeName, verifiedBot: g.dimensions.verifiedBotCategory, securityAction: g.dimensions.securityAction,
    }));
    const clusters = buildClusters(rows.filter((r) => !r.verifiedBot), 8400, {
      kinds: ["ip", "ip24", "asn", "ua"], windowMinutes: 2, minRpm: 60, minShare: 0.02, max: 30,
    });
    const keys = clusters.map((c) => `${c.kind}:${c.target}`);
    expect(keys).toContain("ip:203.0.113.50");
    expect(keys).toContain("ip:198.51.100.7");
    expect(keys).toContain("asn:14061");
    // The shared Chrome user agent is explained by the network cluster, so it isn't judged on its own.
    expect(keys.some((k) => k.startsWith("ua:Mozilla/5.0 (Windows"))).toBe(false);

    const scraper = clusters.find((c) => c.target === "14061")!;
    expect(scraper.features.hosting_asn).toBe(true);
    expect(scraper.features.distinct_ips).toBe(60);
    expect(scraper.features.top_paths[0]!.path).toBe("/lectures/*");
    const scanner = clusters.find((c) => c.target === "198.51.100.7")!;
    expect(scanner.features.flags.has_sqli_pattern).toBe(true);
    expect(JSON.stringify(scanner.features)).not.toMatch(/UNION|passwd/i);
  });
});
