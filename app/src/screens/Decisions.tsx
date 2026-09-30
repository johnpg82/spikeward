import { useEffect, useState } from "preact/hooks";
import { get, post, type Decision, type JevAnswer, type Zone } from "../api";
import { ActionPill, Bar, Btn, Empty, ErrorText, Field, Loading, Page, Time } from "../ui";
import { actionLabel, nowSec, timeLeft, useAsync, useLoad, useTick } from "../util";

const PAGE = 50;
const ACTIONS = ["block", "managed_challenge", "rate_limit", "observe", "allow"];
const ALLOWABLE = ["ip", "ip24", "asn", "ua"];

const ANSWER_NAMES: Record<string, string> = {
  is_automated: "Is it automated?",
  is_welcome: "Is it welcome?",
  intent: "Intent",
  harm: "Harm",
  action: "Advised action",
};

function Answers({ answers }: { answers: Record<string, JevAnswer> }) {
  const keys = Object.keys(answers);
  const order = ["is_automated", "is_welcome", "intent", "harm", "action"];
  const sorted = [...order.filter((k) => k in answers), ...keys.filter((k) => !order.includes(k))];
  return (
    <div>
      {sorted.map((k) => {
        const a = answers[k]!;
        const name = ANSWER_NAMES[k] ?? `Custom: ${k.replace(/^custom_/, "")}`;
        return (
          <div class="answer" key={k}>
            <div class="answer-name">{name}</div>
            {a.type === "noul" && <Bar label="Yes" value={a.noul} strong />}
            {a.type === "choice" && (
              <>
                <div>Chose <strong>{actionLabel(a.choice)}</strong> <span class="muted">(confidence {Math.round(a.confidence * 100)}%)</span></div>
                {Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]).map(([c, p]) => <Bar key={c} label={actionLabel(c)} value={p} strong={c === a.choice} />)}
              </>
            )}
            {a.type === "score" && (
              <>
                <div>Score <strong>{a.score.toFixed(2)}</strong> <span class="muted">(confidence {Math.round(a.confidence * 100)}%)</span></div>
                {Object.entries(a.probabilities).map(([c, p]) => <Bar key={c} label={c} value={p} />)}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Row({ d, note, onDone }: { d: Decision; note?: string; onDone: (id: number, msg: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const { busy, error, run } = useAsync();
  const active = !!d.actionRow && !d.actionRow.removed_at && d.actionRow.expires_at > nowSec();
  const shadowOnly = !d.applied && d.action !== "allow" && d.action !== "observe";
  const bodyId = `dec-${d.id}`;
  return (
    <li class="item">
      <button class="item-head" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
        <span class="item-main">
          <Time ts={d.createdAt} />
          <span class="break">{d.zoneName ?? d.zoneId}</span>
          <code class="break">{d.clusterKey}</code>
          <ActionPill action={d.action} prefix={shadowOnly ? "would" : undefined} />
          {d.applied && <span class="pill">applied</span>}
          {active && d.actionRow && <span class="pill"><Time ts={d.actionRow.expires_at} left={timeLeft(d.actionRow.expires_at)} /></span>}
          <span class="muted">via {d.source}</span>
        </span>
        <span class="chev" aria-hidden="true">{open ? "Hide" : "Details"}</span>
        <span class="item-reason">{d.reason}</span>
      </button>
      {note && <div class="item-body" role="status"><span class="ok-text">{note}</span></div>}
      {open && (
        <div class="item-body" id={bodyId}>
          <div class="row">
            {active && (
              <Btn small variant="danger" busy={busy} busyText="Undoing…" onClick={() => run(async () => { await post(`/decisions/${d.id}/undo`); await onDone(d.id, "Undone."); })}>
                Undo this action
              </Btn>
            )}
            {ALLOWABLE.includes(d.kind) && (
              <Btn small busy={busy} busyText="Saving…" onClick={() => run(async () => { await post(`/decisions/${d.id}/allow`); await onDone(d.id, "Undone and added to never-block."); })}>
                Always allow this {d.kind === "ip24" ? "network" : d.kind === "ua" ? "user agent" : d.kind.toUpperCase()}
              </Btn>
            )}
          </div>
          <ErrorText error={error} />
          <div class="two">
            <div>
              <h3>State sent to Jev</h3>
              <pre class="json" tabIndex={0}>{JSON.stringify(d.state, null, 2)}</pre>
            </div>
            <div>
              <h3>Jev's answers</h3>
              {d.answers ? <Answers answers={d.answers} /> : <p class="muted">Jev wasn't asked. Spikeward used its fallback rules for this cluster.</p>}
            </div>
          </div>
        </div>
      )}
    </li>
  );
}

export function Decisions() {
  const zones = useLoad(() => get<{ zones: Zone[] }>("/zones"), []);
  const [zone, setZone] = useState("");
  const [action, setAction] = useState("");
  const [items, setItems] = useState<Decision[]>([]);
  const [more, setMore] = useState(false);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const first = useAsync();
  const next = useAsync();
  useTick(60000);

  const qs = (before?: number, limit = PAGE) => {
    const p = new URLSearchParams({ limit: String(limit) });
    if (before) p.set("before", String(before));
    if (zone) p.set("zone", zone);
    if (action) p.set("action", action);
    return `/decisions?${p}`;
  };

  useEffect(() => {
    void first.run(async () => {
      const r = await get<{ decisions: Decision[] }>(qs());
      setItems(r.decisions);
      setMore(r.decisions.length === PAGE);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zone, action]);

  const loadMore = () =>
    next.run(async () => {
      const last = items[items.length - 1];
      const r = await get<{ decisions: Decision[] }>(qs(last?.id));
      setItems((cur) => [...cur, ...r.decisions]);
      setMore(r.decisions.length === PAGE);
    });

  const refreshAfter = async (id: number, msg: string) => {
    const r = await get<{ decisions: Decision[] }>(qs(undefined, Math.min(200, Math.max(PAGE, items.length))));
    setItems(r.decisions);
    setNotes((n) => ({ ...n, [id]: msg }));
  };

  return (
    <Page title="Decisions" lede="Every verdict Spikeward reached, newest first. Open a row to see what was sent to Jev and how it answered.">
      <div class="filters">
        <Field label="Zone">
          {(p) => (
            <select {...p} value={zone} onChange={(e) => setZone(e.currentTarget.value)}>
              <option value="">All zones</option>
              {zones.data?.zones.map((z) => <option value={z.id} key={z.id}>{z.name}</option>)}
            </select>
          )}
        </Field>
        <Field label="Action">
          {(p) => (
            <select {...p} value={action} onChange={(e) => setAction(e.currentTarget.value)}>
              <option value="">All actions</option>
              {ACTIONS.map((a) => <option value={a} key={a}>{actionLabel(a)}</option>)}
            </select>
          )}
        </Field>
      </div>
      <ErrorText error={first.error} />
      {first.busy && !items.length && <Loading what="decisions" />}
      {!first.busy && !first.error && items.length === 0 && (
        <Empty title="No decisions yet">When a traffic spike happens, Spikeward groups the traffic into clusters and records each verdict here, including in shadow mode.</Empty>
      )}
      {items.length > 0 && <ul class="list" style="list-style:none;padding:0;margin:0">{items.map((d) => <Row key={d.id} d={d} note={notes[d.id]} onDone={refreshAfter} />)}</ul>}
      <ErrorText error={next.error} />
      {more && <div><Btn busy={next.busy} busyText="Loading…" onClick={() => void loadMore()}>Load 50 more decisions</Btn></div>}
    </Page>
  );
}
