import { describe, expect, it } from "vitest";
import { decide, decideRulesOnly, ttlFor, type Verdict } from "../src/loop/policy";
import { DEFAULTS } from "../src/settings";
import { challengeExpression } from "../src/loop/enforce";
import type { ActionRow } from "../src/db";

const p = DEFAULTS.policy;
const v = (o: Partial<Verdict>): Verdict => ({ pAutomated: 0.99, pWelcome: 0.01, harm: 0.9, intent: "scraper", advisedAction: "block", custom: [], ...o });

describe("policy", () => {
  it("blocks only single IPs, and only when confident and harmful", () => {
    expect(decide("ip", v({}), p, []).action).toBe("block");
    expect(decide("ip", v({ harm: 0.3 }), p, []).action).toBe("managed_challenge");
    expect(decide("asn", v({}), p, []).action).toBe("managed_challenge");
    expect(decide("ua", v({}), p, []).action).toBe("managed_challenge");
    expect(decide("ip24", v({}), p, []).action).toBe("managed_challenge");
    expect(decide("ja4", v({}), p, []).action).toBe("rate_limit");
  });

  it("uses the grey zone, observe band, and welcome services", () => {
    expect(decide("ip", v({ pAutomated: 0.8 }), p, [])).toMatchObject({ action: "managed_challenge", grey: true });
    expect(decide("ip", v({ pAutomated: 0.6 }), p, []).action).toBe("observe");
    expect(decide("ip", v({ pAutomated: 0.2 }), p, []).action).toBe("allow");
    expect(decide("ip", v({ pWelcome: 0.9 }), p, []).action).toBe("allow");
  });

  it("lets custom questions override, but never block a broad target", () => {
    const custom = [{ id: "partner", instructions: "Is this our partner?", threshold: 0.8, action: "allow" as const }];
    expect(decide("asn", v({ custom: [{ id: "partner", p: 0.9 }] }), p, custom).action).toBe("allow");
    const blocky = [{ id: "evil", instructions: "Is this evil?", threshold: 0.5, action: "block" as const }];
    expect(decide("asn", v({ custom: [{ id: "evil", p: 0.9 }] }), p, blocky).action).toBe("managed_challenge");
  });

  it("never blocks in rules-only mode", () => {
    expect(decideRulesOnly("ip", 5000, p, "cap").action).toBe("managed_challenge");
    expect(decideRulesOnly("asn", 50000, p, "cap").action).toBe("observe");
  });

  it("doubles the TTL for repeat offenders, up to 7 days", () => {
    expect(ttlFor("block", 0, p)).toBe(6 * 3600);
    expect(ttlFor("block", 1, p)).toBe(12 * 3600);
    expect(ttlFor("block", 9, p)).toBe(7 * 86400);
  });
});

describe("challenge rule expression", () => {
  const act = (id: number, kind: ActionRow["kind"], target: string): ActionRow => ({
    id, decision_id: id, zone_id: "z", mechanism: "managed_challenge", kind, target, applied_at: 0, expires_at: 1e10, removed_at: null, removed_by: null,
  });

  it("combines targets and escapes user agents", () => {
    const { expression } = challengeExpression([act(1, "asn", "14061"), act(2, "ip24", "203.0.113.0/24"), act(3, "ua", 'bad "bot" \\ 1.0')]);
    expect(expression).toBe('(ip.src in {203.0.113.0/24}) or (ip.src.asnum in {14061}) or (http.user_agent eq "bad \\"bot\\" \\\\ 1.0")');
  });

  it("stays under the size limit, keeping the newest targets", () => {
    const many = Array.from({ length: 500 }, (_, i) => act(i, "ip", `10.0.${Math.floor(i / 250)}.${i % 250}`));
    const { expression, included } = challengeExpression(many);
    expect(expression!.length).toBeLessThanOrEqual(3800);
    expect(included[0]).toBe(0);
    expect(included.length).toBeLessThan(500);
  });

  it("returns null when there is nothing to challenge", () => {
    expect(challengeExpression([]).expression).toBeNull();
  });
});
