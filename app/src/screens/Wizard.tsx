import { useState } from "preact/hooks";
import { post, type AppState, type CfZone } from "../api";
import { Btn, ErrorText, ExtLink, Field, Logo, Notice } from "../ui";
import { useAsync } from "../util";
import { ZonePicker } from "./ZonePicker";

const STEPS = ["Cloudflare", "Jev", "Zones"];

export function Wizard({ state, refresh }: { state: AppState; refresh: () => Promise<void> }) {
  const [step, setStep] = useState(!state.credentials?.cloudflare ? 1 : !state.credentials.jev ? 2 : 3);
  const [zones, setZones] = useState<CfZone[] | undefined>();
  const [count, setCount] = useState(state.zones ?? 0);
  const out = useAsync();

  return (
    <div class="center">
      <div class="center-inner wide">
        <div class="spread">
          <div class="brand" style="padding:0"><Logo />Spikeward setup</div>
          <Btn small variant="quiet" busy={out.busy} busyText="Signing out…" onClick={() => out.run(async () => { await post("/logout"); await refresh(); })}>Sign out</Btn>
        </div>
        <ol class="steps" aria-label="Setup steps">
          {STEPS.map((s, i) => (
            <li key={s} aria-current={step === i + 1 ? "step" : undefined} class={step > i + 1 ? "done" : ""}>
              {i + 1}. {s}{step > i + 1 ? " (done)" : ""}
            </li>
          ))}
        </ol>
        {step === 1 && <CloudflareStep onDone={(z) => { setZones(z); setStep(2); }} skip={!!state.credentials?.cloudflare ? () => setStep(2) : undefined} />}
        {step === 2 && <JevStep onDone={() => setStep(3)} skip={!!state.credentials?.jev ? () => setStep(3) : undefined} />}
        {step === 3 && (
          <div class="stack">
            <div>
              <h1>Choose zones to protect</h1>
              <p class="lede">Add at least one zone. New zones start in shadow mode: for the first 24 hours Spikeward logs what it would do and applies nothing. Review the Decisions screen, then switch the zone to enforce.</p>
            </div>
            <ZonePicker managedIds={[]} initial={zones} onAdded={() => setCount((n) => n + 1)} />
            <div class="form-foot">
              <Btn variant="primary" disabled={count < 1} onClick={() => void refresh()}>Finish setup and open Live</Btn>
              {count < 1 && <span class="muted">Add a zone to continue.</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CloudflareStep({ onDone, skip }: { onDone: (z: CfZone[]) => void; skip?: () => void }) {
  const [token, setToken] = useState("");
  const { busy, error, run } = useAsync();
  const submit = (e: Event) => {
    e.preventDefault();
    void run(async () => {
      const r = await post<{ zones: CfZone[] }>("/credentials/cloudflare", { token });
      onDone(r.zones);
    });
  };
  return (
    <form class="stack" onSubmit={submit}>
      <div>
        <h1>Connect Cloudflare</h1>
        <p class="lede">Spikeward reads traffic analytics and writes short-lived WAF rules through an API token. Create a token with exactly these permissions, scoped to the account and zones you want protected.</p>
      </div>
      <div class="card">
        <h2>Permissions the token needs</h2>
        <ul class="plain">
          <li>Zone → Zone: Read</li>
          <li>Zone → Analytics: Read</li>
          <li>Zone → Zone WAF: Edit</li>
          <li>Account → Account Filter Lists: Edit</li>
        </ul>
        <p><ExtLink href="https://dash.cloudflare.com/profile/api-tokens">Create a token in Cloudflare</ExtLink></p>
        <Field label="Cloudflare API token" help="Stored encrypted in your D1 database. It never leaves your Worker.">
          {(p) => <input {...p} type="password" autocomplete="off" required minLength={20} value={token} onInput={(e) => setToken(e.currentTarget.value)} />}
        </Field>
        <ErrorText error={error} />
        <div class="form-foot">
          <Btn type="submit" variant="primary" busy={busy} busyText="Verifying token…">Verify token and list zones</Btn>
          {skip && <Btn variant="quiet" onClick={skip}>Keep the saved token</Btn>}
        </div>
      </div>
    </form>
  );
}

function JevStep({ onDone, skip }: { onDone: () => void; skip?: () => void }) {
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [model_, setConnected] = useState<string | null>(null);
  const { busy, error, run } = useAsync();
  const submit = (e: Event) => {
    e.preventDefault();
    void run(async () => {
      const r = await post<{ model: string }>("/credentials/jev", {
        key,
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
      });
      setConnected(r.model);
    });
  };
  return (
    <form class="stack" onSubmit={submit}>
      <div>
        <h1>Connect Jev</h1>
        <p class="lede">Jev, by TypeSafe, judges clusters of traffic: automated or not, welcome or not, and what to do about it. Spikeward makes one test call to check the key.</p>
      </div>
      <div class="card">
        <p><ExtLink href="https://typesafe.ai">Get a TypeSafe key</ExtLink></p>
        <Field label="TypeSafe API key" help="Stored encrypted in your D1 database.">
          {(p) => <input {...p} type="password" autocomplete="off" required minLength={10} value={key} onInput={(e) => setKey(e.currentTarget.value)} />}
        </Field>
        <details>
          <summary>Advanced</summary>
          <div class="form-grid" style="margin-top:12px">
            <Field label="Base URL" help="Leave empty to use https://api.typesafe.ai.">
              {(p) => <input {...p} type="url" placeholder="https://api.typesafe.ai" value={baseUrl} onInput={(e) => setBaseUrl(e.currentTarget.value)} />}
            </Field>
            <Field label="Model alias" help="Leave empty to use jev-latest.">
              {(p) => <input {...p} type="text" placeholder="jev-latest" value={model} onInput={(e) => setModel(e.currentTarget.value)} />}
            </Field>
          </div>
        </details>
        <ErrorText error={error} />
        {model_ && <Notice tone="ok"><strong>Connected to {model_}.</strong></Notice>}
        <div class="form-foot">
          {model_ ? (
            <Btn variant="primary" onClick={onDone}>Continue to zones</Btn>
          ) : (
            <Btn type="submit" variant="primary" busy={busy} busyText="Testing key…">Test key and connect</Btn>
          )}
          {skip && !model_ && <Btn variant="quiet" onClick={skip}>Keep the saved key</Btn>}
        </div>
      </div>
    </form>
  );
}
