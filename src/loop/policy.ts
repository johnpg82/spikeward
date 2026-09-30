import type { ClusterKind, Mechanism } from "../db";
import type { Settings } from "../settings";

export type Action = "allow" | "observe" | Mechanism;

/** The judgments policy works from, normalized from Jev's answers. */
export interface Verdict {
  pAutomated: number;
  pWelcome: number;
  /** 0 (harmless) to 1 (severe). */
  harm: number;
  intent: string;
  advisedAction: string;
  custom: { id: string; p: number }[];
}

export interface PolicyResult {
  action: Action;
  reason: string;
  grey: boolean;
}

const BROAD: ClusterKind[] = ["ip24", "asn", "ua"];

/**
 * Jev's suggested action is advisory. These thresholds make the call, so behavior can be
 * tuned without rewriting questions. Broad targets (ranges, networks, user agents) catch
 * real people too, so they are only ever challenged.
 */
export function decide(kind: ClusterKind, v: Verdict, p: Settings["policy"], custom: Settings["jev"]["customQuestions"]): PolicyResult {
  for (const q of custom) {
    const hit = v.custom.find((c) => c.id === q.id);
    if (hit && hit.p >= q.threshold) {
      const action = q.action === "block" ? narrowest(kind) : q.action;
      return { action, reason: `Custom question "${q.id}" answered yes (${fmt(hit.p)}).`, grey: false };
    }
  }
  if (v.pWelcome >= p.legitAllow) {
    return { action: "allow", reason: `Looks like a service you'd want (${fmt(v.pWelcome)}).`, grey: false };
  }
  if (v.pAutomated < p.allowBelow) {
    return { action: "allow", reason: `Looks like people, not software (automated ${fmt(v.pAutomated)}).`, grey: false };
  }
  if (v.pAutomated < p.greyLow) {
    return { action: "observe", reason: `Possibly automated (${fmt(v.pAutomated)}), below the grey zone. Logged only.`, grey: false };
  }
  if (v.pAutomated < p.greyHigh) {
    return {
      action: kind === "ja4" ? "rate_limit" : "managed_challenge",
      reason: `Grey zone (automated ${fmt(v.pAutomated)}): challenge only, and ask you to review.`,
      grey: true,
    };
  }
  if (kind === "ip" && v.harm >= p.blockHarm) {
    return { action: "block", reason: `Automated (${fmt(v.pAutomated)}) and harmful (${fmt(v.harm)}) from a single IP.`, grey: false };
  }
  if (kind === "ja4") {
    return { action: "rate_limit", reason: `Automated (${fmt(v.pAutomated)}); rate limited by TLS fingerprint.`, grey: false };
  }
  const broad = BROAD.includes(kind) ? " Broad targets are only ever challenged." : "";
  return { action: "managed_challenge", reason: `Automated (${fmt(v.pAutomated)}), harm ${fmt(v.harm)}.${broad}`, grey: false };
}

/** Used when Jev is unavailable or a cap is hit. Never blocks. */
export function decideRulesOnly(kind: ClusterKind, rpm: number, p: Settings["policy"], why: string): PolicyResult {
  if (kind === "ip" && rpm >= p.fallbackIpRpm) {
    return { action: "managed_challenge", reason: `Rules-only (${why}): one IP at ${Math.round(rpm)} rpm.`, grey: false };
  }
  return { action: "observe", reason: `Rules-only (${why}): logged, no action.`, grey: false };
}

function narrowest(kind: ClusterKind): Action {
  if (kind === "ip") return "block";
  if (kind === "ja4") return "rate_limit";
  return "managed_challenge";
}

/** Repeat offenders within 24 hours get double the time, up to the maximum. */
export function ttlFor(action: Mechanism, priorOffenses: number, p: Settings["policy"]): number {
  const base = action === "block" ? p.ttlBlock : action === "rate_limit" ? p.ttlRateLimit : p.ttlChallenge;
  return Math.min(base * 2 ** Math.min(priorOffenses, 10), p.maxTtl);
}

const fmt = (x: number) => x.toFixed(2);
