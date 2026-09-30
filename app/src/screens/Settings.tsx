import { useState } from "preact/hooks";
import { del, get, post, put, type AppState, type CustomQuestion, type Issue, type JevTestRow, type Settings, type UsageDay, type Zone } from "../api";
import { ActionPill, Btn, Empty, ErrorText, Field, issueMap, Loading, Notice, Page } from "../ui";
import { actionLabel, fmtNum, useAsync, useLoad } from "../util";
import { CLUSTER_KINDS, SPECS, type Spec } from "./settingsSpec";

type Section = "detection" | "policy" | "jev" | "alerts";
type Overrides = Partial<Record<string, Record<string, unknown>>>;
type Loaded = { settings: Settings; overrides: Overrides };

const round = (n: number) => Math.round(n * 1e6) / 1e6;

const toDraft = (s: Spec, v: unknown): string | boolean | string[] => {
  if (s.kind === "bool") return !!v;
  if (s.kind === "kinds") return [...((v as string[]) ?? [])];
  if (s.kind === "number") return String(round(((v as number) ?? 0) / (s.scale ?? 1)));
  return String(v ?? "");
};

function SectionForm(props: {
  section: Section;
  zone: string;
  values: Record<string, unknown>;
  overridden: Record<string, unknown>;
  reload: () => Promise<void>;
  omit?: string[];
}) {
  const spec = SPECS[props.section];
  const fields = spec.fields.filter((f) => !props.omit?.includes(f.key));
  const [draft, setDraft] = useState<Record<string, string | boolean | string[]>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, toDraft(f, props.values[f.key])])),
  );
  const [saved, setSaved] = useState(false);
  const [local, setLocal] = useState<Record<string, string>>({});
  const { busy, error, issues, run } = useAsync();
  const { byField, rest } = issueMap(issues, props.section);
  const set = (k: string, v: string | boolean | string[]) => (setDraft((d) => ({ ...d, [k]: v })), setSaved(false));

  const submit = (e: Event) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const patch: Record<string, unknown> = {};
    for (const f of fields) {
      const raw = draft[f.key];
      let v: unknown = raw;
      if (f.kind === "number") {
        const n = Number(raw);
        if (String(raw).trim() === "" || !Number.isFinite(n)) {
          errs[f.key] = "Enter a number.";
          continue;
        }
        v = f.int ? Math.round(n * (f.scale ?? 1)) : round(n * (f.scale ?? 1));
      } else if (f.kind === "text" || f.kind === "url" || f.kind === "textarea") v = String(raw).trim();
      if (f.kind === "kinds" && (raw as string[]).length === 0) {
        errs[f.key] = "Pick at least one way to group traffic.";
        continue;
      }
      if (!props.zone || JSON.stringify(v) !== JSON.stringify(props.values[f.key])) patch[f.key] = v;
    }
    setLocal(errs);
    if (Object.keys(errs).length) return;
    if (!Object.keys(patch).length) {
      setLocal({ _: "Nothing changed yet." });
      return;
    }
    void run(async () => {
      await put(props.zone ? `/settings?zone=${encodeURIComponent(props.zone)}` : "/settings", { [props.section]: patch });
      setSaved(true);
      await props.reload();
    });
  };

  const tag = (k: string) => (props.zone && props.overridden[k] !== undefined ? "Overridden for this zone" : undefined);

  return (
    <form class="card" onSubmit={submit} noValidate>
      <div class="form-grid">
        {fields.map((f) => {
          const err = local[f.key] ?? byField[f.key];
          const cls = f.wide ? "wide" : "";
          if (f.kind === "bool")
            return (
              <div class={`field ${cls}`} key={f.key}>
                <FieldCheck spec={f} checked={draft[f.key] as boolean} onChange={(v) => set(f.key, v)} tag={tag(f.key)} error={err} />
              </div>
            );
          if (f.kind === "kinds")
            return (
              <fieldset class={`wide`} key={f.key} aria-describedby={`${f.key}-h`}>
                <legend class="legend">{f.label}{tag(f.key) && <span class="tag">{tag(f.key)}</span>}</legend>
                <div class="checks">
                  {CLUSTER_KINDS.map((k) => {
                    const cur = draft[f.key] as string[];
                    return (
                      <label class="check" key={k.id}>
                        <input type="checkbox" checked={cur.includes(k.id)} onChange={(e) => set(f.key, e.currentTarget.checked ? [...cur, k.id] : cur.filter((x) => x !== k.id))} />
                        {k.label}
                      </label>
                    );
                  })}
                </div>
                <p class="help" id={`${f.key}-h`}>{f.help}</p>
                {err && <p class="error">{err}</p>}
              </fieldset>
            );
          return (
            <Field key={f.key} label={f.label} help={f.help} error={err} tag={tag(f.key)} class={cls}>
              {(p) =>
                f.kind === "textarea" ? (
                  <textarea {...p} rows={3} maxLength={500} value={draft[f.key] as string} onInput={(e) => set(f.key, e.currentTarget.value)} />
                ) : f.kind === "number" ? (
                  <div class="input-unit">
                    <input {...p} type="number" inputMode="decimal" step="any" min={f.min !== undefined ? round(f.min / (f.scale ?? 1)) : undefined} max={f.max !== undefined ? round(f.max / (f.scale ?? 1)) : undefined} value={draft[f.key] as string} onInput={(e) => set(f.key, e.currentTarget.value)} />
                    {f.unit && <span class="unit">{f.unit}</span>}
                  </div>
                ) : (
                  <input {...p} type={f.kind === "url" ? "url" : "text"} value={draft[f.key] as string} onInput={(e) => set(f.key, e.currentTarget.value)} />
                )
              }
            </Field>
          );
        })}
      </div>
      <ErrorText error={error} />
      {local._ && <p class="help">{local._}</p>}
      {rest.length > 0 && <ul class="plain error">{rest.map((r) => <li key={r}>{r}</li>)}</ul>}
      <div class="form-foot">
        <Btn type="submit" variant="primary" busy={busy} busyText="Saving…">{spec.save}</Btn>
        {saved && !busy && !error && <span class="ok-text" role="status">Saved</span>}
        {props.zone && <span class="muted">Saves only the fields you changed as overrides for this zone.</span>}
      </div>
    </form>
  );
}

function FieldCheck({ spec, checked, onChange, tag, error }: { spec: Spec; checked: boolean; onChange: (v: boolean) => void; tag?: string; error?: string }) {
  return (
    <>
      <label class="check">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.currentTarget.checked)} />
        <span>{spec.label}{tag && <span class="tag">{tag}</span>}<span class="help">{spec.help}</span></span>
      </label>
      {error && <p class="error">{error}</p>}
    </>
  );
}

export function SettingsPage({ section, state, refresh }: { section: Section; state?: AppState; refresh?: () => Promise<void> }) {
  const [zone, setZone] = useState("");
  const zones = useLoad(() => get<{ zones: Zone[] }>("/zones"), []);
  const data = useLoad(() => get<Loaded>(`/settings${zone ? `?zone=${encodeURIComponent(zone)}` : ""}`), [zone]);
  const [version, setVersion] = useState(0);
  const clear = useAsync();
  const [confirm, setConfirm] = useState(false);
  const spec = SPECS[section];

  const reload = async () => { await data.reload(); };
  const reset = async () => { await data.reload(); setVersion((v) => v + 1); };
  const zoneName = zones.data?.zones.find((z) => z.id === zone)?.name;
  const overridden = (data.data?.overrides[section] ?? {}) as Record<string, unknown>;
  const count = Object.values(data.data?.overrides ?? {}).reduce((n, o) => n + Object.keys(o ?? {}).length, 0);

  return (
    <Page title={spec.title} lede={spec.lede}>
      <div class="card">
        <Field label="Settings apply to" help="Choose a zone to give it its own values. Fields you don't change keep following the global settings.">
          {(p) => (
            <select {...p} value={zone} onChange={(e) => { setZone(e.currentTarget.value); setConfirm(false); }}>
              <option value="">All zones (global)</option>
              {zones.data?.zones.map((z) => <option value={z.id} key={z.id}>{z.name}</option>)}
            </select>
          )}
        </Field>
        {zone && (
          <div class="stack" style="gap:8px">
            <p>
              Editing <strong>{zoneName ?? zone}</strong>. {count ? `${count} setting${count === 1 ? " is" : "s are"} overridden across all sections.` : "No overrides yet; this zone follows the global settings."}
            </p>
            {count > 0 && !confirm && <div><Btn small variant="danger" onClick={() => setConfirm(true)}>Clear overrides</Btn></div>}
            {confirm && (
              <div class="confirm bad" role="group" aria-label="Confirm clearing overrides">
                <p>Clear every override for {zoneName ?? "this zone"}? It will follow the global settings again.</p>
                <div class="row">
                  <Btn small variant="danger" busy={clear.busy} busyText="Clearing…" onClick={() => clear.run(async () => { await del(`/settings?zone=${encodeURIComponent(zone)}`); setConfirm(false); await reset(); })}>Clear overrides for {zoneName ?? "zone"}</Btn>
                  <Btn small variant="quiet" onClick={() => setConfirm(false)}>Keep overrides</Btn>
                </div>
              </div>
            )}
            <ErrorText error={clear.error} />
          </div>
        )}
      </div>
      {data.loading && !data.data && <Loading what="settings" />}
      <ErrorText error={data.error} />
      {data.data && (
        <>
          <SectionForm
            key={`${section}-${zone}-${version}`}
            section={section}
            zone={zone}
            values={data.data.settings[section] as unknown as Record<string, unknown>}
            overridden={overridden}
            reload={reload}
          />
          {section === "jev" && (
            <>
              <CustomQuestions key={`cq-${zone}-${version}`} zone={zone} initial={data.data.settings.jev.customQuestions} tagged={overridden.customQuestions !== undefined} reload={reload} />
              <TestCard />
              <UsageCard />
              <Reconnect state={state} refresh={refresh} reload={reset} />
            </>
          )}
        </>
      )}
    </Page>
  );
}

// Custom questions

type QDraft = { id: string; instructions: string; yes: string; no: string; threshold: string; action: CustomQuestion["action"] };
const blankQ = (): QDraft => ({ id: "", instructions: "", yes: "", no: "", threshold: "0.8", action: "managed_challenge" });

function CustomQuestions({ zone, initial, tagged, reload }: { zone: string; initial: CustomQuestion[]; tagged: boolean; reload: () => Promise<void> }) {
  const [qs, setQs] = useState<QDraft[]>(() =>
    initial.map((q) => ({ id: q.id, instructions: q.instructions, yes: q.yes ?? "", no: q.no ?? "", threshold: String(q.threshold), action: q.action })),
  );
  const [saved, setSaved] = useState(false);
  const [local, setLocal] = useState<string | null>(null);
  const { busy, error, issues, run } = useAsync();
  const edit = (i: number, patch: Partial<QDraft>) => (setQs((cur) => cur.map((q, j) => (j === i ? { ...q, ...patch } : q))), setSaved(false));

  const fieldErr = (i: number, f: string) => issues.find((x: Issue) => x.path[0] === "jev" && x.path[1] === "customQuestions" && x.path[2] === i && x.path[3] === f)?.message;
  const other = issues.filter((x) => !(x.path[1] === "customQuestions" && typeof x.path[2] === "number" && typeof x.path[3] === "string")).map((x) => `${x.path.join(" › ")}: ${x.message}`);

  const submit = (e: Event) => {
    e.preventDefault();
    const out: CustomQuestion[] = [];
    for (const [i, q] of qs.entries()) {
      const t = Number(q.threshold);
      if (q.threshold.trim() === "" || !Number.isFinite(t)) return setLocal(`Question ${i + 1}: enter a threshold between 0 and 1.`);
      out.push({ id: q.id.trim(), instructions: q.instructions.trim(), threshold: t, action: q.action, ...(q.yes.trim() ? { yes: q.yes.trim() } : {}), ...(q.no.trim() ? { no: q.no.trim() } : {}) });
    }
    setLocal(null);
    void run(async () => {
      await put(zone ? `/settings?zone=${encodeURIComponent(zone)}` : "/settings", { jev: { customQuestions: out } });
      setSaved(true);
      await reload();
    });
  };

  return (
    <form class="card" onSubmit={submit} noValidate>
      <div>
        <h2>Custom questions{tagged && zone && <span class="tag">Overridden for this zone</span>}</h2>
        <p class="help">Ask Jev something specific to your site, such as "Is this a partner integration?". When Jev answers yes with at least the threshold probability, the action you choose is taken before the standard rules run. You can add up to 10.</p>
      </div>
      {qs.length === 0 && <Empty title="No custom questions">Add one if the standard questions miss something about your traffic.</Empty>}
      {qs.map((q, i) => (
        <fieldset class="cq" key={i}>
          <legend class="legend">Question {i + 1}</legend>
          <div class="form-grid">
            <Field label="Identifier" help="Lowercase letters, digits and underscores. Starts with a letter." error={fieldErr(i, "id")}>
              {(p) => <input {...p} type="text" spellcheck={false} value={q.id} onInput={(e) => edit(i, { id: e.currentTarget.value })} />}
            </Field>
            <Field label="Take this action on yes" error={fieldErr(i, "action")}>
              {(p) => (
                <select {...p} value={q.action} onChange={(e) => edit(i, { action: e.currentTarget.value as QDraft["action"] })}>
                  {["allow", "observe", "managed_challenge", "block"].map((a) => <option key={a} value={a}>{actionLabel(a)}</option>)}
                </select>
              )}
            </Field>
            <Field label="Question for Jev" help="5 to 2000 characters. Refer to the traffic as `cluster`." class="wide" error={fieldErr(i, "instructions")}>
              {(p) => <textarea {...p} rows={3} value={q.instructions} onInput={(e) => edit(i, { instructions: e.currentTarget.value })} />}
            </Field>
            <Field label="What yes means" help="Optional. Describes the traffic that should answer yes." error={fieldErr(i, "yes")}>
              {(p) => <input {...p} type="text" value={q.yes} onInput={(e) => edit(i, { yes: e.currentTarget.value })} />}
            </Field>
            <Field label="What no means" help="Optional. Describes the traffic that should answer no." error={fieldErr(i, "no")}>
              {(p) => <input {...p} type="text" value={q.no} onInput={(e) => edit(i, { no: e.currentTarget.value })} />}
            </Field>
            <Field label="Threshold" help="Probability of yes needed to act, 0 to 1." error={fieldErr(i, "threshold")}>
              {(p) => <input {...p} type="number" step="any" min={0} max={1} value={q.threshold} onInput={(e) => edit(i, { threshold: e.currentTarget.value })} />}
            </Field>
          </div>
          <div><Btn small variant="danger" onClick={() => (setQs(qs.filter((_, j) => j !== i)), setSaved(false))}>Remove question {i + 1}</Btn></div>
        </fieldset>
      ))}
      <ErrorText error={local ?? error} />
      {other.length > 0 && <ul class="plain error">{other.map((r) => <li key={r}>{r}</li>)}</ul>}
      <div class="form-foot">
        <Btn disabled={qs.length >= 10} onClick={() => (setQs([...qs, blankQ()]), setSaved(false))}>{qs.length >= 10 ? "Limit of 10 reached" : "Add a question"}</Btn>
        <Btn type="submit" variant="primary" busy={busy} busyText="Saving…">Save custom questions</Btn>
        {saved && !busy && !error && <span class="ok-text" role="status">Saved</span>}
      </div>
    </form>
  );
}

// Test against last spike

function TestCard() {
  const { busy, error, run } = useAsync();
  const [res, setRes] = useState<{ spikeId: number; results: JevTestRow[] } | null>(null);
  return (
    <div class="card">
      <div>
        <h2>Test against the last spike</h2>
        <p class="help">Re-asks Jev about up to 10 clusters from the most recent spike using your current questions and policy. Nothing is applied. This uses Jev calls.</p>
      </div>
      <div><Btn busy={busy} busyText="Asking Jev…" onClick={() => run(async () => setRes(await post("/jev/test")))}>Test against last spike</Btn></div>
      <ErrorText error={error} />
      {res && res.results.length === 0 && <p class="muted">The last spike has no recorded clusters to test.</p>}
      {res && res.results.length > 0 && (
        <div class="table-wrap">
          <table>
            <caption class="sr">Results for spike {res.spikeId}</caption>
            <thead><tr><th>Cluster</th><th>Before → after</th><th>Reason</th></tr></thead>
            <tbody>
              {res.results.map((r) => (
                <tr key={r.decisionId}>
                  <td class="mono break">{r.clusterKey}</td>
                  <td class="nowrap"><ActionPill action={r.before} /> → <ActionPill action={r.after} />{r.before !== r.after && <span class="sr"> (changed)</span>}</td>
                  <td>{r.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function UsageCard() {
  const { data, error, loading } = useLoad(() => get<{ days: UsageDay[] }>("/usage"), []);
  return (
    <div class="card">
      <div>
        <h2>Jev usage</h2>
        <p class="help">The last 30 days. Cost is an estimate from input tokens and your price setting.</p>
      </div>
      {loading && <Loading what="usage" />}
      <ErrorText error={error} />
      {data && data.days.length === 0 && <Empty title="No Jev calls yet">Usage appears here after Spikeward first asks Jev about a cluster, which happens during a spike.</Empty>}
      {data && data.days.length > 0 && (
        <div class="table-wrap">
          <table>
            <thead><tr><th>Day</th><th class="num">Calls</th><th class="num">Input tokens</th><th class="num">Estimated cost</th></tr></thead>
            <tbody>
              {data.days.map((d) => (
                <tr key={d.day}><td>{d.day}</td><td class="num">{fmtNum(d.jev_calls)}</td><td class="num">{fmtNum(d.jev_input_tokens)}</td><td class="num">${d.est_cost.toFixed(4)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Reconnect({ state, refresh, reload }: { state?: AppState; refresh?: () => Promise<void>; reload: () => Promise<void> }) {
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [ok, setOk] = useState<string | null>(null);
  const { busy, error, issues, run } = useAsync();
  const submit = (e: Event) => {
    e.preventDefault();
    setOk(null);
    void run(async () => {
      const r = await post<{ model: string }>("/credentials/jev", { key, ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}), ...(model.trim() ? { model: model.trim() } : {}) });
      setOk(r.model);
      setKey("");
      await refresh?.();
      await reload();
    });
  };
  return (
    <form class="card" onSubmit={submit}>
      <div>
        <h2>Reconnect Jev</h2>
        <p class="help">
          {state?.credentials?.jev ? <>A key is saved{state.credentials.jev.model ? <> for model <code>{state.credentials.jev.model}</code></> : null}. </> : null}
          Paste a new TypeSafe key to replace it. Spikeward tests it before saving.
        </p>
      </div>
      <Field label="TypeSafe API key">
        {(p) => <input {...p} type="password" autocomplete="off" required minLength={10} value={key} onInput={(e) => setKey(e.currentTarget.value)} />}
      </Field>
      <details>
        <summary>Advanced</summary>
        <div class="form-grid" style="margin-top:12px">
          <Field label="Base URL" help="Leave empty to keep the current value.">
            {(p) => <input {...p} type="url" value={baseUrl} onInput={(e) => setBaseUrl(e.currentTarget.value)} />}
          </Field>
          <Field label="Model alias" help="Leave empty to keep the current value.">
            {(p) => <input {...p} type="text" value={model} onInput={(e) => setModel(e.currentTarget.value)} />}
          </Field>
        </div>
      </details>
      <ErrorText error={error} />
      {issues.length > 0 && <ul class="plain error">{issues.map((i) => <li key={i.path.join(".")}>{i.path.join(" › ")}: {i.message}</li>)}</ul>}
      {ok && <Notice tone="ok"><strong>Connected to {ok}.</strong></Notice>}
      <div class="form-foot"><Btn type="submit" variant="primary" busy={busy} busyText="Testing key…">Test and save key</Btn></div>
    </form>
  );
}
