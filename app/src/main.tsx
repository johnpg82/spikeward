import { render } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import "./styles.css";
import { get, post, UNAUTHORIZED_EVENT, type AppState } from "./api";
import { Btn, ErrorText, Link, Logo } from "./ui";
import { navigate, ROUTES, useAsync, usePath } from "./util";
import { Claim, SignIn } from "./screens/Auth";
import { Wizard } from "./screens/Wizard";
import { Live } from "./screens/Live";
import { Decisions } from "./screens/Decisions";
import { Actions } from "./screens/Actions";
import { Zones } from "./screens/Zones";
import { SettingsPage } from "./screens/Settings";
import { NeverBlock } from "./screens/NeverBlock";
import { Account } from "./screens/Account";

const NAV: { href: string; label: string; group?: string }[] = [
  { href: "/live", label: "Live" },
  { href: "/decisions", label: "Decisions" },
  { href: "/actions", label: "Actions" },
  { href: "/zones", label: "Zones" },
  { href: "/settings/detection", label: "Detection", group: "Settings" },
  { href: "/settings/policy", label: "Policy" },
  { href: "/settings/jev", label: "Jev" },
  { href: "/settings/alerts", label: "Alerts" },
  { href: "/settings/never-block", label: "Never-block list" },
  { href: "/settings/account", label: "Account" },
];

const TITLES: Record<string, string> = Object.fromEntries(NAV.map((n) => [n.href, n.label]));

function KillSwitch({ state, refresh }: { state: AppState; refresh: () => Promise<void> }) {
  const { busy, error, run } = useAsync();
  const [confirming, setConfirming] = useState(false);
  const set = (on: boolean) =>
    run(async () => {
      await post("/killswitch", { on });
      await refresh();
      setConfirming(false);
    });
  if (state.kill) return null;
  return (
    <div class="kill-wrap">
      {confirming ? (
        <>
          <span>Disable every Spikeward rule now?</span>
          <Btn variant="danger" small busy={busy} busyText="Turning on…" onClick={() => set(true)}>Turn on kill switch</Btn>
          <Btn small variant="quiet" disabled={busy} onClick={() => setConfirming(false)}>Cancel</Btn>
        </>
      ) : (
        <Btn small variant="danger" onClick={() => setConfirming(true)}>Kill switch</Btn>
      )}
      <ErrorText error={error} />
    </div>
  );
}

function Shell({ state, refresh }: { state: AppState; refresh: () => Promise<void> }) {
  const path = usePath();
  const main = useRef<HTMLElement>(null);
  const { busy, error, run } = useAsync();
  const first = useRef(true);

  useEffect(() => {
    document.title = `${TITLES[path] ?? "Spikeward"} · Spikeward`;
    if (first.current) first.current = false;
    else main.current?.focus();
    window.scrollTo(0, 0);
  }, [path]);

  let screen;
  switch (path) {
    case "/live": screen = <Live />; break;
    case "/decisions": screen = <Decisions />; break;
    case "/actions": screen = <Actions />; break;
    case "/zones": screen = <Zones />; break;
    case "/settings/detection": screen = <SettingsPage section="detection" />; break;
    case "/settings/policy": screen = <SettingsPage section="policy" />; break;
    case "/settings/jev": screen = <SettingsPage section="jev" state={state} refresh={refresh} />; break;
    case "/settings/alerts": screen = <SettingsPage section="alerts" />; break;
    case "/settings/never-block": screen = <NeverBlock />; break;
    case "/settings/account": screen = <Account state={state} refresh={refresh} />; break;
    default: screen = null;
  }

  return (
    <>
      <a class="skip" href="#main" onClick={(e) => { e.preventDefault(); main.current?.focus(); }}>Skip to content</a>
      {state.kill && (
        <div class="kill-banner" role="alert">
          <span>Kill switch is on: every Spikeward rule is disabled</span>
          <Btn small busy={busy} busyText="Turning off…" onClick={() => run(async () => { await post("/killswitch", { on: false }); await refresh(); })}>Turn off</Btn>
          {error && <span>{error}</span>}
        </div>
      )}
      <div class="shell">
        <aside class="side">
          <Link class="brand" href="/live" aria-label="Spikeward, go to Live"><Logo />Spikeward</Link>
          <nav class="nav" aria-label="Main">
            {NAV.map((n) => (
              <>
                {n.group && <span class="nav-group" aria-hidden="true">{n.group}</span>}
                <Link href={n.href} aria-current={path === n.href ? "page" : undefined}>{n.label}</Link>
              </>
            ))}
          </nav>
        </aside>
        <div class="head">
          <span class="who">Signed in as {state.user?.name} · v{state.version}</span>
          <KillSwitch state={state} refresh={refresh} />
        </div>
        <main class="main" id="main" tabIndex={-1} ref={main}>{screen}</main>
      </div>
    </>
  );
}

function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const path = usePath();

  const refresh = useCallback(async () => {
    try {
      setState(await get<AppState>("/state"));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const on = () => void refresh();
    window.addEventListener(UNAUTHORIZED_EVENT, on);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, on);
  }, [refresh]);

  const ready = !!state?.user && !!state.credentials?.cloudflare && !!state.credentials.jev && (state.zones ?? 0) > 0;
  const known = (ROUTES as readonly string[]).includes(path);
  useEffect(() => {
    if (ready && !known) navigate("/live", true);
  }, [ready, known]);

  if (error && !state) {
    return (
      <div class="center"><div class="center-inner">
        <h1>Can't load Spikeward</h1>
        <ErrorText error={error} />
        <div><Btn onClick={() => void refresh()}>Try again</Btn></div>
      </div></div>
    );
  }
  if (!state) return <div class="center"><p class="muted" role="status">Loading Spikeward…</p></div>;
  if (!state.claimed) return <Claim onDone={refresh} />;
  if (!state.user) return <SignIn onDone={refresh} />;
  if (!ready) return <Wizard state={state} refresh={refresh} />;
  if (!known) return null;
  return <Shell state={state} refresh={refresh} />;
}

render(<App />, document.getElementById("app")!);
