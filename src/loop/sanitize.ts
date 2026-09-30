// Turns raw paths and query strings into safe patterns plus attack flags. Raw probes in the
// state can trip the WAF in front of the Jev API, and query values can identify visitors.

export interface AttackFlags {
  has_sqli_pattern: boolean;
  has_xss_pattern: boolean;
  has_traversal_pattern: boolean;
  has_rce_pattern: boolean;
}

const PATTERNS: Record<keyof AttackFlags, RegExp> = {
  has_sqli_pattern:
    /(\bunion\b[\s\S]*\bselect\b|\bselect\b[\s\S]+\bfrom\b|'\s*(or|and)\s*'?\d|'\s*--|\bsleep\s*\(|\bbenchmark\s*\(|information_schema|\bwaitfor\s+delay\b)/i,
  has_xss_pattern: /(<\s*script|javascript:|\bon(error|load|mouseover)\s*=|<\s*svg|<\s*img|<\s*iframe|\balert\s*\(|document\.cookie)/i,
  has_traversal_pattern: /(\.\.[\\/]|%2e%2e|\/etc\/(passwd|shadow|hosts)|win\.ini|boot\.ini|\/proc\/self)/i,
  has_rce_pattern: /(;\s*(cat|ls|id|wget|curl|uname|whoami)\b|\$\(|`|\|\s*(sh|bash|nc)\b|cmd\.exe|\/bin\/(ba)?sh|\$\{jndi:)/i,
};

const LOGIN = /(^|\/)(login|log-in|signin|sign-in|signup|register|auth|oauth|session|sessions|wp-login\.php|account\/login|user\/login|password|reset)(\/|$|\.|\?)/i;

export function safeDecode(s: string): string {
  let out = s;
  for (let i = 0; i < 2; i++) {
    try {
      const next = decodeURIComponent(out.replace(/\+/g, " "));
      if (next === out) break;
      out = next;
    } catch {
      break;
    }
  }
  return out;
}

export function attackFlags(...parts: string[]): AttackFlags {
  const text = parts.map(safeDecode).join(" ");
  const flags = {} as AttackFlags;
  for (const [k, re] of Object.entries(PATTERNS) as [keyof AttackFlags, RegExp][]) flags[k] = re.test(text);
  return flags;
}

export const anyFlag = (f: AttackFlags) => Object.values(f).some(Boolean);

export function hitsLogin(path: string): boolean {
  return LOGIN.test(path);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `/users/12345/posts/abc-def` -> `/users/*\/posts/abc-def`; attack paths collapse to a marker. */
export function normalizePath(path: string): string {
  const flags = attackFlags(path);
  if (anyFlag(flags)) return "[attack pattern removed]";
  const segs = path.split("/").map((seg) => {
    if (!seg) return seg;
    if (/^\d+$/.test(seg) || UUID.test(seg) || /^[0-9a-f]{12,}$/i.test(seg) || seg.length > 40) return "*";
    if (/^[A-Za-z0-9_-]{24,}$/.test(seg) && /\d/.test(seg)) return "*";
    return seg;
  });
  const out = segs.join("/") || "/";
  return out.length > 120 ? out.slice(0, 117) + "..." : out;
}

/** Keeps parameter names only: `q=secret&page=2` -> `?q=*&page=*`. */
export function normalizeQuery(query: string): string {
  if (!query) return "";
  const raw = query.startsWith("?") ? query.slice(1) : query;
  const keys: string[] = [];
  for (const part of raw.split("&")) {
    const key = safeDecode(part.split("=")[0] ?? "").slice(0, 30);
    if (!key || anyFlag(attackFlags(key)) || !/^[\w.\-[\]]+$/.test(key)) continue;
    if (!keys.includes(key)) keys.push(key);
    if (keys.length >= 5) break;
  }
  return keys.length ? "?" + keys.map((k) => `${k}=*`).join("&") : "";
}
