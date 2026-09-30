import { useState } from "preact/hooks";
import { del, get, post, type AllowEntry, type Zone } from "../api";
import { Btn, Empty, ErrorText, Field, issueMap, Loading, Page, Time } from "../ui";
import { useAsync, useLoad } from "../util";

const KINDS = [
  { id: "ip", label: "IP address", help: "For example 203.0.113.7", ph: "203.0.113.7" },
  { id: "asn", label: "ASN", help: "A network number, for example 15169", ph: "15169" },
  { id: "ua", label: "User agent", help: "Text the user agent contains, for example Googlebot", ph: "Googlebot" },
  { id: "path", label: "Path", help: "A URL path, for example /webhooks/stripe", ph: "/webhooks/stripe" },
] as const;

function Entry({ e, zoneName, reload }: { e: AllowEntry; zoneName: string; reload: () => Promise<void> }) {
  const { busy, error, run } = useAsync();
  return (
    <tr>
      <td>{KINDS.find((k) => k.id === e.kind)?.label ?? e.kind}</td>
      <td class="mono break">{e.value}</td>
      <td>{zoneName}</td>
      <td class="break">{e.note ?? ""}</td>
      <td><Time ts={e.created_at} /></td>
      <td>
        <Btn small variant="danger" busy={busy} busyText="Removing…" onClick={() => run(async () => { await del(`/allowlist/${e.id}`); await reload(); })} aria-label={`Remove ${e.value} from the never-block list`}>Remove</Btn>
        <ErrorText error={error} />
      </td>
    </tr>
  );
}

export function NeverBlock() {
  const list = useLoad(() => get<{ entries: AllowEntry[] }>("/allowlist"), []);
  const zones = useLoad(() => get<{ zones: Zone[] }>("/zones"), []);
  const [kind, setKind] = useState<AllowEntry["kind"]>("ip");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [zoneId, setZoneId] = useState("");
  const { busy, error, issues, run } = useAsync();
  const { byField } = issueMap(issues.map((i) => ({ ...i, path: ["a", ...i.path] })), "a");
  const k = KINDS.find((x) => x.id === kind)!;
  const names = new Map(zones.data?.zones.map((z) => [z.id, z.name]));

  const submit = (e: Event) => {
    e.preventDefault();
    void run(async () => {
      await post("/allowlist", { zoneId, kind, value, ...(note.trim() ? { note: note.trim() } : {}) });
      setValue("");
      setNote("");
      await list.reload();
    });
  };

  return (
    <Page title="Never-block list" lede="Traffic matching an entry is never challenged or blocked, even when Jev flags it. Use it for your own IPs, trusted partners, and webhooks.">
      <form class="card" onSubmit={submit}>
        <h2>Add an entry</h2>
        <div class="form-grid">
          <Field label="Type" error={byField.kind}>
            {(p) => <select {...p} value={kind} onChange={(e) => setKind(e.currentTarget.value as AllowEntry["kind"])}>{KINDS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select>}
          </Field>
          <Field label="Value" help={k.help} error={byField.value}>
            {(p) => <input {...p} type="text" required maxLength={500} placeholder={k.ph} spellcheck={false} value={value} onInput={(e) => setValue(e.currentTarget.value)} />}
          </Field>
          <Field label="Applies to">
            {(p) => (
              <select {...p} value={zoneId} onChange={(e) => setZoneId(e.currentTarget.value)}>
                <option value="">All zones</option>
                {zones.data?.zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
              </select>
            )}
          </Field>
          <Field label="Note" help="Optional. Why this is here." error={byField.note}>
            {(p) => <input {...p} type="text" maxLength={200} value={note} onInput={(e) => setNote(e.currentTarget.value)} />}
          </Field>
        </div>
        <ErrorText error={error} />
        <div class="form-foot"><Btn type="submit" variant="primary" busy={busy} busyText="Adding…">Add to never-block list</Btn></div>
      </form>
      {list.loading && !list.data && <Loading what="the list" />}
      <ErrorText error={list.error} />
      {list.data && list.data.entries.length === 0 && <Empty title="Nothing on the list yet">Entries you add here, and targets you mark "Always allow" on the Decisions screen, appear here.</Empty>}
      {list.data && list.data.entries.length > 0 && (
        <div class="table-wrap">
          <table>
            <caption class="sr">Never-block entries</caption>
            <thead><tr><th>Type</th><th>Value</th><th>Zone</th><th>Note</th><th>Added</th><th>Change</th></tr></thead>
            <tbody>
              {list.data.entries.map((e) => <Entry key={e.id} e={e} zoneName={e.zone_id ? names.get(e.zone_id) ?? e.zone_id : "All zones"} reload={list.reload} />)}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}
