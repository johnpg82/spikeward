import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { ApiError, type Issue } from "./api";

export const nowSec = () => Math.floor(Date.now() / 1000);

export function absTime(ts: number | null | undefined): string {
  return ts ? new Date(ts * 1000).toLocaleString() : "";
}

function span(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} sec`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 && h < 6 ? `${h} h ${m % 60} min` : `${h} h`;
  return `${Math.round(h / 24)} days`;
}

export const ago = (ts: number | null | undefined): string => {
  if (!ts) return "never";
  const d = nowSec() - ts;
  return d < 5 ? "just now" : `${span(d)} ago`;
};

export const timeLeft = (ts: number): string => {
  const d = ts - nowSec();
  return d <= 0 ? "expired" : `${span(d)} left`;
};

export const fmtNum = (n: number, digits = 0) =>
  n.toLocaleString(undefined, { maximumFractionDigits: digits });

export const pct = (p: number) => `${Math.round(p * 100)}%`;

export const actionLabel = (a: string) => a.replace(/_/g, " ");

/** Re-render on an interval so relative times stay fresh. */
export function useTick(ms = 30000) {
  const [, set] = useState(0);
  useEffect(() => {
    const id = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

/** Runs a request wrapper that tracks in-flight state and a readable error. */
export function useAsync() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    setIssues([]);
    try {
      return await fn();
    } catch (e) {
      if (!alive.current) return undefined;
      const err = e as ApiError;
      setError(err.message || "Something went wrong.");
      setIssues(err.issues ?? []);
      return undefined;
    } finally {
      if (alive.current) setBusy(false);
    }
  }, []);
  return { busy, error, issues, run, clear: () => (setError(null), setIssues([])) };
}

/** Loads data on mount (and on `deps` change), optionally polling. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = [], pollMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const reload = useCallback(async () => {
    try {
      setData(await fnRef.current());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    setLoading(true);
    void reload();
    if (!pollMs) return;
    const id = setInterval(() => {
      if (!document.hidden) void reload();
    }, pollMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, loading, reload, setData };
}

export function download(name: string, text: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Client-side routing

export const ROUTES = [
  "/live",
  "/decisions",
  "/actions",
  "/zones",
  "/settings/detection",
  "/settings/policy",
  "/settings/jev",
  "/settings/alerts",
  "/settings/never-block",
  "/settings/account",
] as const;

export function navigate(path: string, replace = false) {
  if (replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  return path;
}
