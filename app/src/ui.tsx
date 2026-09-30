import type { ComponentChildren, JSX } from "preact";
import { useId } from "preact/hooks";
import type { Issue } from "./api";
import { absTime, actionLabel, ago, navigate, pct } from "./util";

export function Link(props: JSX.HTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const { href, onClick, ...rest } = props;
  return (
    <a
      {...rest}
      href={href}
      onClick={(e) => {
        onClick?.(e as never);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(href);
      }}
    />
  );
}

export function Btn(
  props: Omit<JSX.IntrinsicElements["button"], "size" | "ref"> & {
    busy?: boolean;
    busyText?: string;
    variant?: "primary" | "danger" | "quiet";
    small?: boolean;
  },
) {
  const { busy, busyText, variant, small, children, disabled, class: cls, type, ...rest } = props;
  return (
    <button
      {...rest}
      type={type ?? "button"}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      class={`btn ${variant ?? ""} ${small ? "small" : ""} ${cls ?? ""}`}
    >
      {busy && busyText ? busyText : children}
    </button>
  );
}

export function ErrorText({ error }: { error?: string | null }) {
  if (!error) return null;
  return (
    <p class="error" role="alert">
      {error}
    </p>
  );
}

export function Notice({ children, tone = "info" }: { children: ComponentChildren; tone?: "info" | "ok" | "warn" | "bad" }) {
  return (
    <div class={`notice ${tone}`} role={tone === "bad" ? "alert" : "status"}>
      {children}
    </div>
  );
}

type FieldProps = { id: string; "aria-describedby"?: string };

export function Field(props: {
  label: string;
  help?: ComponentChildren;
  error?: string | null;
  tag?: string;
  children: (p: FieldProps) => ComponentChildren;
  class?: string;
}) {
  const id = useId();
  const hid = `${id}-h`;
  const eid = `${id}-e`;
  const describedBy = [props.help ? hid : "", props.error ? eid : ""].filter(Boolean).join(" ");
  return (
    <div class={`field ${props.class ?? ""}`}>
      <label for={id}>
        {props.label}
        {props.tag && <span class="tag">{props.tag}</span>}
      </label>
      {props.children({ id, "aria-describedby": describedBy || undefined })}
      {props.help && (
        <p class="help" id={hid}>
          {props.help}
        </p>
      )}
      {props.error && (
        <p class="error" id={eid}>
          {props.error}
        </p>
      )}
    </div>
  );
}

export function Time({ ts, left }: { ts: number | null | undefined; left?: string }) {
  if (!ts) return <span class="muted">never</span>;
  return <time datetime={new Date(ts * 1000).toISOString()} title={absTime(ts)}>{left ?? ago(ts)}</time>;
}

export function ActionPill({ action, prefix }: { action: string; prefix?: string }) {
  return <span class={`pill a-${action}`}>{prefix ? `${prefix} ` : ""}{actionLabel(action)}</span>;
}

export function Bar({ value, label, strong }: { value: number; label: string; strong?: boolean }) {
  const v = Math.max(0, Math.min(1, value));
  return (
    <div class={`bar ${strong ? "strong" : ""}`}>
      <span class="bar-label">{label}</span>
      <span class="bar-track" role="img" aria-label={`${label}: ${pct(v)}`}>
        <span class="bar-fill" style={{ width: `${v * 100}%` }} />
      </span>
      <span class="bar-num">{pct(v)}</span>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ComponentChildren }) {
  return (
    <div class="empty">
      <p class="empty-title">{title}</p>
      {children && <p class="muted">{children}</p>}
    </div>
  );
}

export function Page(props: { title: string; lede?: ComponentChildren; children: ComponentChildren; actions?: ComponentChildren }) {
  return (
    <div class="page">
      <header class="page-head">
        <div>
          <h1>{props.title}</h1>
          {props.lede && <p class="lede">{props.lede}</p>}
        </div>
        {props.actions && <div class="page-actions">{props.actions}</div>}
      </header>
      {props.children}
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return <p class="muted" role="status">Loading {what}…</p>;
}

/** Zod issue helpers: paths look like [section, field, ...]. */
export function issueMap(issues: Issue[], section: string): { byField: Record<string, string>; rest: string[] } {
  const byField: Record<string, string> = {};
  const rest: string[] = [];
  for (const i of issues) {
    const p = i.path;
    if (p[0] === section && typeof p[1] === "string" && p.length === 2) byField[p[1]] ??= i.message;
    else rest.push(`${p.join(" › ") || "value"}: ${i.message}`);
  }
  return { byField, rest };
}

export function Logo() {
  return (
    <svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
      <path d="M2 22 L9 21 L13 6 L17 21 L30 21" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" />
      <path d="M2 27 H30" stroke="var(--ward)" stroke-width="3" stroke-linecap="round" />
    </svg>
  );
}

export function ExtLink({ href, children }: { href: string; children: ComponentChildren }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}<span class="sr"> (opens in a new tab)</span>
    </a>
  );
}
