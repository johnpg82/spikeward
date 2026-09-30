import { useState } from "preact/hooks";
import { del, get, patch, type Mode, type Zone } from "../api";
import { Btn, Empty, ErrorText, Loading, Page, Time } from "../ui";
import { useAsync, useLoad } from "../util";
import { ZonePicker } from "./ZonePicker";

const MODES: { id: Mode; label: string; help: string }[] = [
  { id: "off", label: "Off", help: "Spikeward does nothing on this zone." },
  { id: "shadow", label: "Shadow", help: "Logs what it would do. Nothing is applied." },
  { id: "enforce", label: "Enforce", help: "Applies challenges and blocks." },
];

function Feature({ on, children }: { on: boolean | number; children?: preact.ComponentChildren }) {
  return on ? <span class="yes">{children ?? "Available"}</span> : <span class="no">Not on this plan</span>;
}

function ZoneCard({ z, reload }: { z: Zone; reload: () => Promise<void> }) {
  const { busy, error, run } = useAsync();
  const [pending, setPending] = useState<Mode | null>(null);
  const [removing, setRemoving] = useState(false);
  const setMode = (mode: Mode) =>
    run(async () => {
      await patch(`/zones/${z.id}`, { mode });
      setPending(null);
      await reload();
    });
  const choose = (m: Mode) => {
    if (m === z.mode) return;
    if (m === "enforce") setPending(m);
    else void setMode(m);
  };
  const f = z.features;
  return (
    <section class="card" aria-label={z.name}>
      <div class="zone-head">
        <div><h2 class="break">{z.name}</h2><span class="muted">{z.plan} plan</span></div>
        <span class={`pill mode-${z.mode}`}>{z.mode}</span>
      </div>
      <div class="stack" style="gap:6px">
        <div class="legend" id={`m-${z.id}`}>Mode</div>
        <div class="seg" role="radiogroup" aria-labelledby={`m-${z.id}`}>
          {MODES.map((m) => (
            <button key={m.id} role="radio" aria-checked={z.mode === m.id} disabled={busy} onClick={() => choose(m.id)} title={m.help}>{m.label}</button>
          ))}
        </div>
        <p class="help">{MODES.find((m) => m.id === z.mode)?.help}{z.mode === "shadow" && z.shadowSince ? <> Shadow period started <Time ts={z.shadowSince} />.</> : null}</p>
      </div>
      {pending === "enforce" && (
        <div class="confirm" role="group" aria-label="Confirm enforce mode">
          <p>
            {z.shadowSince && z.mode === "shadow" ? <>This zone has been in shadow mode since <Time ts={z.shadowSince} />. </> : null}
            Spikeward recommends reviewing 24 hours of shadow decisions first. In enforce mode it applies challenges and blocks on Cloudflare at the next check.
          </p>
          <div class="row">
            <Btn variant="danger" small busy={busy} busyText="Switching…" onClick={() => void setMode("enforce")}>Switch {z.name} to enforce</Btn>
            <Btn small variant="quiet" disabled={busy} onClick={() => setPending(null)}>Stay in {z.mode}</Btn>
          </div>
        </div>
      )}
      <div class="table-wrap">
        <table class="features">
          <caption class="sr">Features available on the {z.plan} plan</caption>
          <tbody>
            <tr><td>Spike detection from analytics</td><td><Feature on={f.polling} /></td></tr>
            <tr><td>IP blocks</td><td><Feature on={f.ipBlocks} /></td></tr>
            <tr><td>Managed challenges</td><td><Feature on={f.challenges} /></td></tr>
            <tr><td>IP list capacity</td><td><Feature on={f.ipLists}>{f.ipLists} {f.ipLists === 1 ? "list" : "lists"}</Feature></td></tr>
            <tr><td>JA4 fingerprint clusters</td><td><Feature on={f.ja4} /></td></tr>
            <tr><td>Bot score</td><td><Feature on={f.botScore} /></td></tr>
            <tr><td>JA4 rate limiting</td><td><Feature on={f.ja4RateLimit} /></td></tr>
          </tbody>
        </table>
      </div>
      <ErrorText error={error} />
      {z.lastError && <div class="zone-err" role="alert">Last error: {z.lastError}</div>}
      {removing ? (
        <div class="confirm bad" role="group" aria-label="Confirm removal">
          <p>Removes Spikeward's rules from this zone. Active blocks and challenges end, and the zone's overrides are deleted.</p>
          <div class="row">
            <RemoveButton id={z.id} name={z.name} reload={reload} />
            <Btn small variant="quiet" onClick={() => setRemoving(false)}>Keep zone</Btn>
          </div>
        </div>
      ) : (
        <div><Btn small variant="danger" onClick={() => setRemoving(true)} aria-label={`Remove ${z.name} from Spikeward`}>Remove zone</Btn></div>
      )}
    </section>
  );
}

function RemoveButton({ id, name, reload }: { id: string; name: string; reload: () => Promise<void> }) {
  const { busy, error, run } = useAsync();
  return (
    <>
      <Btn small variant="danger" busy={busy} busyText="Removing…" onClick={() => run(async () => { await del(`/zones/${id}`); await reload(); })}>Remove {name}</Btn>
      <ErrorText error={error} />
    </>
  );
}

export function Zones() {
  const { data, error, loading, reload } = useLoad(() => get<{ zones: Zone[] }>("/zones"), []);
  const [adding, setAdding] = useState(false);
  return (
    <Page
      title="Zones"
      lede="Each zone runs in one of three modes. New zones start in shadow: Spikeward logs what it would do for 24 hours, applies nothing, and you switch to enforce when the decisions look right."
      actions={<Btn onClick={() => setAdding(!adding)} aria-expanded={adding}>{adding ? "Done adding zones" : "Add a zone"}</Btn>}
    >
      {adding && (
        <div class="card">
          <h2>Add a zone</h2>
          <ZonePicker managedIds={data?.zones.map((z) => z.id) ?? []} onAdded={() => void reload()} />
        </div>
      )}
      {loading && !data && <Loading what="zones" />}
      <ErrorText error={error} />
      {data && data.zones.length === 0 && <Empty title="No zones yet">Use "Add a zone" to pick one your Cloudflare token can see.</Empty>}
      {data && <div class="cards">{data.zones.map((z) => <ZoneCard key={z.id} z={z} reload={reload} />)}</div>}
    </Page>
  );
}
