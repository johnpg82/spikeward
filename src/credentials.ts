import type { Env } from "./env";
import { decrypt, encrypt } from "./crypto";
import { now } from "./db";

export type CredentialKind = "cloudflare" | "jev";

export async function saveCredential(env: Env, kind: CredentialKind, value: string, meta: Record<string, unknown> = {}) {
  const { ciphertext, iv } = await encrypt(env.SPIKEWARD_SECRET, value);
  await env.DB.prepare("INSERT OR REPLACE INTO credentials (kind, ciphertext, iv, meta, verified_at) VALUES (?, ?, ?, ?, ?)")
    .bind(kind, ciphertext, iv, JSON.stringify(meta), now()).run();
}

export async function loadCredential(env: Env, kind: CredentialKind): Promise<{ value: string; meta: Record<string, unknown>; verifiedAt: number } | null> {
  const row = await env.DB.prepare("SELECT ciphertext, iv, meta, verified_at FROM credentials WHERE kind = ?").bind(kind)
    .first<{ ciphertext: string; iv: string; meta: string | null; verified_at: number }>();
  if (!row) return null;
  try {
    return { value: await decrypt(env.SPIKEWARD_SECRET, row.ciphertext, row.iv), meta: JSON.parse(row.meta ?? "{}"), verifiedAt: row.verified_at };
  } catch {
    // SPIKEWARD_SECRET changed: the stored value can't be read and must be entered again.
    return null;
  }
}

export async function credentialStatus(env: Env) {
  const { results } = await env.DB.prepare("SELECT kind, meta, verified_at FROM credentials").all<{ kind: string; meta: string | null; verified_at: number }>();
  return Object.fromEntries(results.map((r) => [r.kind, { verifiedAt: r.verified_at, ...JSON.parse(r.meta ?? "{}") }]));
}
