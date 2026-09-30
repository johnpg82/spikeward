import { useRef, useState } from "preact/hooks";
import { del, get, post, put, type AppState, type Settings, type UserRow, type VersionInfo } from "../api";
import { Btn, ErrorText, ExtLink, Field, Loading, Notice, Page, Time } from "../ui";
import { download, useAsync, useLoad } from "../util";

export function Account({ state, refresh }: { state: AppState; refresh: () => Promise<void> }) {
  return (
    <Page title="Account" lede="Admins, credentials, backups, and this install's version.">
      <Version />
      <Users me={state.user?.name ?? ""} />
      <Password />
      <Cloudflare state={state} refresh={refresh} />
      <Retention />
      <Backup />
      <SignOut refresh={refresh} />
    </Page>
  );
}

function Version() {
  const { data, error } = useLoad(() => get<VersionInfo>("/version"), []);
  return (
    <div class="card">
      <h2>Version</h2>
      <p>Spikeward <code>v{data?.current ?? "…"}</code></p>
      {data?.updateAvailable && data.latest && (
        <Notice tone="warn">
          Update available: v{data.latest}. {data.url && <ExtLink href={data.url}>See what changed</ExtLink>}
        </Notice>
      )}
      {data && !data.updateAvailable && data.latest && <p class="muted">You're on the latest release.</p>}
      {data && !data.latest && <p class="muted">Couldn't check for updates right now.</p>}
      <ErrorText error={error} />
    </div>
  );
}

function Users({ me }: { me: string }) {
  const list = useLoad(() => get<{ users: UserRow[] }>("/users"), []);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState<number | null>(null);
  const add = useAsync();
  const rm = useAsync();
  return (
    <div class="card">
      <h2>Admins</h2>
      {list.loading && !list.data && <Loading what="admins" />}
      <ErrorText error={list.error} />
      {list.data && (
        <div class="table-wrap">
          <table>
            <caption class="sr">Admin users</caption>
            <thead><tr><th>Name</th><th>Added</th><th>Change</th></tr></thead>
            <tbody>
              {list.data.users.map((u) => (
                <tr key={u.id}>
                  <td>{u.name}{u.name === me && <span class="muted"> (you)</span>}</td>
                  <td><Time ts={u.created_at} /></td>
                  <td>
                    {confirm === u.id ? (
                      <div class="row">
                        <Btn small variant="danger" busy={rm.busy} busyText="Removing…" onClick={() => rm.run(async () => { await del(`/users/${u.id}`); setConfirm(null); await list.reload(); })}>Confirm remove {u.name}</Btn>
                        <Btn small variant="quiet" onClick={() => setConfirm(null)}>Keep</Btn>
                      </div>
                    ) : (
                      <Btn small variant="danger" onClick={() => { rm.clear(); setConfirm(u.id); }} aria-label={`Remove admin ${u.name}`}>Remove</Btn>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ErrorText error={rm.error} />
      <form class="stack" onSubmit={(e) => { e.preventDefault(); void add.run(async () => { await post("/users", { name, password }); setName(""); setPassword(""); await list.reload(); }); }}>
        <h3>Add an admin</h3>
        <div class="form-grid">
          <Field label="Name">{(p) => <input {...p} type="text" required maxLength={60} autocomplete="off" value={name} onInput={(e) => setName(e.currentTarget.value)} />}</Field>
          <Field label="Password" help="At least 10 characters.">{(p) => <input {...p} type="password" required minLength={10} maxLength={200} autocomplete="new-password" value={password} onInput={(e) => setPassword(e.currentTarget.value)} />}</Field>
        </div>
        <ErrorText error={add.error} />
        <div class="form-foot"><Btn type="submit" variant="primary" busy={add.busy} busyText="Adding…">Add admin</Btn></div>
      </form>
    </div>
  );
}

function Password() {
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [done, setDone] = useState(false);
  const { busy, error, run } = useAsync();
  return (
    <form class="card" onSubmit={(e) => { e.preventDefault(); setDone(false); void run(async () => { await post("/users/me/password", { current, password }); setCurrent(""); setPassword(""); setDone(true); }); }}>
      <h2>Change my password</h2>
      <div class="form-grid">
        <Field label="Current password">{(p) => <input {...p} type="password" required autocomplete="current-password" value={current} onInput={(e) => setCurrent(e.currentTarget.value)} />}</Field>
        <Field label="New password" help="At least 10 characters.">{(p) => <input {...p} type="password" required minLength={10} maxLength={200} autocomplete="new-password" value={password} onInput={(e) => setPassword(e.currentTarget.value)} />}</Field>
      </div>
      <ErrorText error={error} />
      <div class="form-foot">
        <Btn type="submit" variant="primary" busy={busy} busyText="Changing…">Change password</Btn>
        {done && <span class="ok-text" role="status">Password changed.</span>}
      </div>
    </form>
  );
}

function Cloudflare({ state, refresh }: { state: AppState; refresh: () => Promise<void> }) {
  const [token, setToken] = useState("");
  const [zones, setZones] = useState<number | null>(null);
  const { busy, error, run } = useAsync();
  const cf = state.credentials?.cloudflare;
  return (
    <form class="card" onSubmit={(e) => { e.preventDefault(); setZones(null); void run(async () => { const r = await post<{ zones: unknown[] }>("/credentials/cloudflare", { token }); setZones(r.zones.length); setToken(""); await refresh(); }); }}>
      <div>
        <h2>Cloudflare token</h2>
        <p class="help">{cf ? <>Last verified <Time ts={cf.verifiedAt} />. </> : null}Paste a token to re-verify it or rotate to a new one. It needs Zone: Read, Analytics: Read, Zone WAF: Edit, and Account Filter Lists: Edit. <ExtLink href="https://dash.cloudflare.com/profile/api-tokens">Create a token in Cloudflare</ExtLink></p>
      </div>
      <Field label="Cloudflare API token">{(p) => <input {...p} type="password" required minLength={20} autocomplete="off" value={token} onInput={(e) => setToken(e.currentTarget.value)} />}</Field>
      <ErrorText error={error} />
      {zones !== null && <Notice tone="ok"><strong>Token verified.</strong> It can see {zones} zone{zones === 1 ? "" : "s"}.</Notice>}
      <div class="form-foot"><Btn type="submit" variant="primary" busy={busy} busyText="Verifying…">Verify and save token</Btn></div>
    </form>
  );
}

function Retention() {
  const { data, reload } = useLoad(() => get<{ settings: Settings }>("/settings"), []);
  const [val, setVal] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const { busy, error, issues, run } = useAsync();
  const shown = val ?? String(data?.settings.retentionDays ?? "");
  return (
    <form class="card" onSubmit={(e) => { e.preventDefault(); setSaved(false); void run(async () => { await put("/settings", { retentionDays: Number(shown) }); setSaved(true); setVal(null); await reload(); }); }}>
      <h2>Data retention</h2>
      <Field label="Keep decisions and spike history for" help="Older records are deleted. Range 1 to 3650 days." error={issues[0]?.message}>
        {(p) => (
          <div class="input-unit">
            <input {...p} type="number" step={1} min={1} max={3650} required value={shown} onInput={(e) => (setVal(e.currentTarget.value), setSaved(false))} />
            <span class="unit">days</span>
          </div>
        )}
      </Field>
      <ErrorText error={error} />
      <div class="form-foot">
        <Btn type="submit" variant="primary" busy={busy} busyText="Saving…" disabled={!data}>Save retention</Btn>
        {saved && <span class="ok-text" role="status">Saved</span>}
      </div>
    </form>
  );
}

function Backup() {
  const exp = useAsync();
  const imp = useAsync();
  const file = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<{ name: string; text: string } | null>(null);
  const [done, setDone] = useState(false);
  const [local, setLocal] = useState<string | null>(null);

  const pick = async (f: File | undefined) => {
    setDone(false);
    setLocal(null);
    if (!f) return setPicked(null);
    const text = await f.text();
    try {
      JSON.parse(text);
      setPicked({ name: f.name, text });
    } catch {
      setPicked(null);
      setLocal("That file isn't valid JSON. Choose a file exported from Spikeward.");
    }
  };

  return (
    <div class="card">
      <h2>Export and import</h2>
      <p class="help">The export contains settings, per-zone overrides, and the never-block list. It never includes your Cloudflare token or Jev key.</p>
      <div class="form-foot">
        <Btn busy={exp.busy} busyText="Exporting…" onClick={() => exp.run(async () => { const d = await get<{ exportedAt: string }>("/export"); download(`spikeward-config-${d.exportedAt.slice(0, 10)}.json`, JSON.stringify(d, null, 2)); })}>Export configuration</Btn>
      </div>
      <ErrorText error={exp.error} />
      <Field label="Import a configuration file" help="Choose a JSON file exported from Spikeward.">
        {(p) => <input {...p} ref={file} type="file" accept="application/json,.json" onChange={(e) => void pick(e.currentTarget.files?.[0])} />}
      </Field>
      <ErrorText error={local} />
      {picked && (
        <div class="confirm bad" role="group" aria-label="Confirm import">
          <p>Import {picked.name}? This replaces all current settings, per-zone overrides, and the never-block list.</p>
          <div class="row">
            <Btn small variant="danger" busy={imp.busy} busyText="Importing…" onClick={() => imp.run(async () => { await post("/import", JSON.parse(picked.text)); setDone(true); setPicked(null); if (file.current) file.current.value = ""; })}>Replace my configuration</Btn>
            <Btn small variant="quiet" disabled={imp.busy} onClick={() => { setPicked(null); if (file.current) file.current.value = ""; }}>Cancel import</Btn>
          </div>
        </div>
      )}
      <ErrorText error={imp.error} />
      {imp.issues.length > 0 && <ul class="plain error">{imp.issues.map((i) => <li key={i.path.join(".") + i.message}>{i.path.join(" › ")}: {i.message}</li>)}</ul>}
      {done && <Notice tone="ok">Imported. Settings take effect on the next check.</Notice>}
    </div>
  );
}

function SignOut({ refresh }: { refresh: () => Promise<void> }) {
  const { busy, error, run } = useAsync();
  return (
    <div class="card">
      <h2>Sign out</h2>
      <div><Btn busy={busy} busyText="Signing out…" onClick={() => run(async () => { await post("/logout"); await refresh(); })}>Sign out of Spikeward</Btn></div>
      <ErrorText error={error} />
    </div>
  );
}
