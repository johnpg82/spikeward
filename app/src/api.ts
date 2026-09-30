// Typed client for the Spikeward Worker API. Same-origin cookies; writes carry the CSRF header.

export interface Issue {
  path: (string | number)[];
  message: string;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly issues: Issue[] = []) {
    super(message);
  }
}

export const UNAUTHORIZED_EVENT = "spikeward:unauthorized";

export async function api<T = { ok: true }>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (method !== "GET") headers["X-Spikeward"] = "1";
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("Couldn't reach the Spikeward Worker. Check your connection and try again.", 0);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; issues?: Issue[] };
    if (res.status === 401 && path !== "/login") window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new ApiError(d.error ?? `Request failed (${res.status}).`, res.status, d.issues ?? []);
  }
  return data as T;
}

export const get = <T>(path: string) => api<T>("GET", path);
export const post = <T = { ok: true }>(path: string, body?: unknown) => api<T>("POST", path, body ?? {});
export const put = <T = { ok: true }>(path: string, body?: unknown) => api<T>("PUT", path, body ?? {});
export const patch = <T = { ok: true }>(path: string, body?: unknown) => api<T>("PATCH", path, body ?? {});
export const del = <T = { ok: true }>(path: string) => api<T>("DELETE", path);

// Response shapes (mirrors src/api/routes.ts)

export interface AppState {
  claimed: boolean;
  user: { id: number; name: string } | null;
  version: string;
  credentials?: { cloudflare?: { verifiedAt: number; zones?: number }; jev?: { verifiedAt: number; model?: string } };
  zones?: number;
  kill?: boolean;
}

export interface CfZone {
  id: string;
  name: string;
  plan: string;
  account: string;
}

export interface RpmPoint {
  t: number;
  rpm: number;
  baseline: number | null;
}

export type Mode = "off" | "shadow" | "enforce";

export interface Zone {
  id: string;
  name: string;
  plan: string;
  mode: Mode;
  shadowSince: number | null;
  pausedUntil: number | null;
  lastTickAt: number | null;
  lastError: string | null;
  features: {
    polling: boolean;
    ipBlocks: boolean;
    challenges: boolean;
    ipLists: number;
    ja4: boolean;
    botScore: boolean;
    ja4RateLimit: boolean;
  };
  series: RpmPoint[];
  spike: { id: number; peak: number } | null;
  activeActions: number;
  rules: unknown;
}

export type ActionName = "allow" | "observe" | "managed_challenge" | "rate_limit" | "block";

export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; probabilities: Record<string, number>; confidence: number };

export interface Decision {
  id: number;
  zoneId: string;
  zoneName: string | null;
  spikeId: number | null;
  clusterKey: string;
  kind: string;
  state: unknown;
  answers: Record<string, JevAnswer> | null;
  source: "jev" | "cache" | "rules" | string;
  action: ActionName;
  reason: string;
  applied: boolean;
  createdAt: number;
  actionRow: { id: number; expires_at: number; removed_at: number | null; removed_by: string | null } | null;
}

export interface ActiveAction {
  id: number;
  decision_id: number | null;
  zone_id: string;
  zone_name: string;
  mechanism: string;
  kind: string;
  target: string;
  applied_at: number;
  expires_at: number;
}

export interface AllowEntry {
  id: number;
  zone_id: string;
  kind: "ip" | "asn" | "ua" | "path";
  value: string;
  note: string | null;
  created_at: number;
}

export interface CustomQuestion {
  id: string;
  instructions: string;
  yes?: string;
  no?: string;
  threshold: number;
  action: "allow" | "observe" | "managed_challenge" | "block";
}

export interface Settings {
  detection: {
    spikeMultiple: number;
    spikeFloorRpm: number;
    clusterKinds: string[];
    minClusterRpm: number;
    minClusterShare: number;
    maxClustersPerTick: number;
    windowMinutes: number;
    lagMinutes: number;
    calmMinutesToEnd: number;
  };
  policy: {
    allowBelow: number;
    greyLow: number;
    greyHigh: number;
    blockHarm: number;
    legitAllow: number;
    ttlChallenge: number;
    ttlRateLimit: number;
    ttlBlock: number;
    maxTtl: number;
    maxActionsPerHour: number;
    rateLimitPerMinute: number;
    fallbackIpRpm: number;
  };
  jev: {
    baseUrl: string;
    model: string;
    siteDescription: string;
    maxCallsPerTick: number;
    dailyCallCap: number;
    dailySpendCap: number;
    pricePerMillionTokens: number;
    customQuestions: CustomQuestion[];
  };
  alerts: { webhookUrl: string; onSpike: boolean; onGrey: boolean; onPause: boolean };
  retentionDays: number;
}

export interface UsageDay {
  day: string;
  jev_calls: number;
  jev_input_tokens: number;
  est_cost: number;
}

export interface JevTestRow {
  decisionId: number;
  clusterKey: string;
  before: string;
  after: string;
  reason: string;
}

export interface UserRow {
  id: number;
  name: string;
  role: string;
  created_at: number;
}

export interface VersionInfo {
  current: string;
  latest: string | null;
  url: string | null;
  updateAvailable: boolean;
}
