import { get, post, type ActiveAction } from "../api";
import { Btn, Empty, ErrorText, Loading, Page, Time } from "../ui";
import { timeLeft, useAsync, useLoad, useTick } from "../util";
import { useState } from "preact/hooks";

function Row({ a, reload }: { a: ActiveAction; reload: () => Promise<void> }) {
  const { busy, error, run } = useAsync();
  const [confirm, setConfirm] = useState(false);
  const act = (fn: () => Promise<unknown>) => run(async () => { await fn(); await reload(); });
  return (
    <tr>
      <td class="break">{a.zone_name}</td>
      <td>{a.mechanism.replace(/_/g, " ")}</td>
      <td>{a.kind.replace(/_/g, " ")}</td>
      <td class="mono break">{a.target}</td>
      <td><Time ts={a.applied_at} /></td>
      <td class="nowrap"><Time ts={a.expires_at} left={timeLeft(a.expires_at)} /></td>
      <td>
        <div class="row">
          <Btn small disabled={busy} onClick={() => act(() => post(`/actions/${a.id}/extend`, { seconds: 3600 }))} aria-label={`Add 1 hour to ${a.target}`}>+1 hour</Btn>
          <Btn small disabled={busy} onClick={() => act(() => post(`/actions/${a.id}/extend`, { seconds: -3600 }))} aria-label={`Remove 1 hour from ${a.target}`}>−1 hour</Btn>
          {confirm ? (
            <>
              <Btn small variant="danger" busy={busy} busyText="Removing…" onClick={() => act(() => post(`/actions/${a.id}/remove`))}>Confirm remove</Btn>
              <Btn small variant="quiet" disabled={busy} onClick={() => setConfirm(false)}>Keep</Btn>
            </>
          ) : (
            <Btn small variant="danger" disabled={busy} onClick={() => setConfirm(true)} aria-label={`Remove action on ${a.target}`}>Remove</Btn>
          )}
        </div>
        <ErrorText error={error} />
      </td>
    </tr>
  );
}

export function Actions() {
  const { data, error, loading, reload } = useLoad(() => get<{ actions: ActiveAction[] }>("/actions"), [], 30000);
  useTick(30000);
  return (
    <Page title="Actions" lede="Active blocks and challenges. Every one expires on its own; extend, shorten, or remove any of them here. Cloudflare updates within a minute.">
      {loading && !data && <Loading what="actions" />}
      <ErrorText error={error} />
      {data && data.actions.length === 0 && <Empty title="No active actions">When Spikeward challenges or blocks traffic, each rule appears here with its time left.</Empty>}
      {data && data.actions.length > 0 && (
        <div class="table-wrap">
          <table>
            <caption class="sr">Active actions</caption>
            <thead><tr><th>Zone</th><th>Mechanism</th><th>Kind</th><th>Target</th><th>Applied</th><th>Expires</th><th>Change</th></tr></thead>
            <tbody>{data.actions.map((a) => <Row key={a.id} a={a} reload={reload} />)}</tbody>
          </table>
        </div>
      )}
    </Page>
  );
}
