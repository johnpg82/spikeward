import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "./env";
import { sign, verifySig } from "./crypto";

export const COOKIE = "sw_session";
const SESSION_SECONDS = 7 * 86400;

export interface SessionUser {
  id: number;
  name: string;
}

export type AppEnv = { Bindings: Env; Variables: { user: SessionUser | null } };

export async function startSession(c: Context<AppEnv>, user: SessionUser) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const payload = `${user.id}.${exp}`;
  const sig = await sign(c.env.SPIKEWARD_SECRET, "session", payload);
  setCookie(c, COOKIE, `${payload}.${sig}`, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Strict",
    path: "/",
    maxAge: SESSION_SECONDS,
  });
}

export function endSession(c: Context<AppEnv>) {
  deleteCookie(c, COOKIE, { path: "/" });
}

/** Reads the signed session cookie. Sessions are stateless; deleting a user ends theirs on the next request. */
export const session: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("user", null);
  const raw = getCookie(c, COOKIE);
  const [id, exp, sig] = raw?.split(".") ?? [];
  if (id && exp && sig && Number(exp) > Date.now() / 1000 && (await verifySig(c.env.SPIKEWARD_SECRET, "session", `${id}.${exp}`, sig))) {
    const user = await c.env.DB.prepare("SELECT id, name FROM users WHERE id = ?").bind(Number(id)).first<SessionUser>();
    if (user) c.set("user", user);
  }
  await next();
};

/**
 * Every write must carry `X-Spikeward: 1`. Browsers can't send a custom header cross-site
 * without a CORS preflight, which this API never grants, so this blocks CSRF.
 */
export const csrf: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.header("x-spikeward") !== "1") {
    return c.json({ error: "Missing X-Spikeward header." }, 403);
  }
  await next();
};

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get("user")) return c.json({ error: "Sign in to continue." }, 401);
  await next();
};

/** 10 attempts per 15 minutes per client IP, for login and claim. */
export async function rateLimited(c: Context<AppEnv>, bucket: string): Promise<boolean> {
  const ip = c.req.header("cf-connecting-ip") ?? "local";
  const key = `rl:${bucket}:${ip}`;
  const n = Number((await c.env.KV.get(key)) ?? "0");
  if (n >= 10) return true;
  await c.env.KV.put(key, String(n + 1), { expirationTtl: 900 });
  return false;
}
