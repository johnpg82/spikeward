import type { Env } from "./env";
import { sign } from "./crypto";
import { getMeta } from "./db";
import type { Settings } from "./settings";

/** Posts to a Slack- or Discord-compatible webhook. Failures are swallowed: alerts never break the loop. */
export async function sendAlert(settings: Settings, text: string): Promise<void> {
  const url = settings.alerts.webhookUrl;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, content: text.slice(0, 1900) }),
    });
  } catch {
    // ignored
  }
}

/** Approve and reject links for grey-zone verdicts. Valid for 24 hours, no login needed. */
export async function reviewLinks(env: Env, decisionId: number): Promise<{ approve: string; reject: string } | null> {
  const origin = await getMeta(env, "origin");
  if (!origin) return null;
  const exp = Math.floor(Date.now() / 1000) + 86400;
  const link = async (op: string) => {
    const sig = await sign(env.SPIKEWARD_SECRET, "review", `${decisionId}|${op}|${exp}`);
    return `${origin}/api/review?d=${decisionId}&op=${op}&exp=${exp}&sig=${sig}`;
  };
  return { approve: await link("approve"), reject: await link("reject") };
}
