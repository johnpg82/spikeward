import { get, type RpmPoint, type Zone } from "../api";
import { Empty, ErrorText, Link, Loading, Page, Time } from "../ui";
import { fmtNum, useLoad, useTick } from "../util";

export function Sparkline({ series, name }: { series: RpmPoint[]; name: string }) {
  const W = 300;
  const H = 70;
  const pts = series.slice(-120);
  const max = Math.max(1, ...pts.map((p) => Math.max(p.rpm, p.baseline ?? 0))) * 1.08;
  const x = (i: number) => (pts.length < 2 ? W : (i / (pts.length - 1)) * W);
  const y = (v: number) => H - 3 - (v / max) * (H - 6);
  const rpm = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.rpm).toFixed(1)}`).join(" ");
  let base = "";
  let pen = false;
  pts.forEach((p, i) => {
    if (p.baseline === null) return void (pen = false);
    base += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(p.baseline).toFixed(1)} `;
    pen = true;
  });
  const last = pts[pts.length - 1];
  return (
    <svg class="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
      aria-label={`Requests per minute for ${name}, last ${pts.length} checks. Latest ${last?.rpm ?? 0}${last?.baseline != null ? ` against a baseline of ${last.baseline}` : ""}.`}>
      {base && <path class="base" d={base} />}
      <path class="rpm" d={rpm} />
    </svg>
  );
}

function ZoneCard({ z }: { z: Zone }) {
  const last = z.series[z.series.length - 1];
  const collecting = z.series.length === 0;
  return (
    <section class="card" aria-label={z.name}>
      <div class="zone-head">
        <div>
          <h2 class="break">{z.name}</h2>
          <span class="muted">{z.plan} plan</span>
        </div>
        <div class="badges">
          <span class={`pill mode-${z.mode}`}>{z.mode}</span>
          {z.spike ? <span class="pill spike">Spike, peak {fmtNum(z.spike.peak)} rpm</span> : !collecting && <span class="pill calm">No spike</span>}
        </div>
      </div>
      {z.lastError && <div class="zone-err" role="alert">Last error: {z.lastError}</div>}
      {z.pausedUntil && <div class="notice warn">Paused: Spikeward hit its hourly action limit. New actions resume <Time ts={z.pausedUntil} />.</div>}
      {collecting ? (
        <Empty title="Collecting a baseline">Collecting a baseline. Spike detection starts after about 10 minutes of traffic.</Empty>
      ) : (
        <>
          <Sparkline series={z.series} name={z.name} />
          <div class="legend-row" aria-hidden="true">
            <span><span class="key" />Requests per minute</span>
            <span><span class="key dash" />Baseline</span>
          </div>
          <dl class="stats" style="margin:0">
            <div class="stat"><dt>Current</dt><dd>{fmtNum(last?.rpm ?? 0)} <small>rpm</small></dd></div>
            <div class="stat"><dt>Baseline</dt><dd>{last?.baseline != null ? fmtNum(last.baseline) : "…"} <small>{last?.baseline != null ? "rpm" : "learning"}</small></dd></div>
            <div class="stat"><dt>Active actions</dt><dd>{z.activeActions}</dd></div>
          </dl>
        </>
      )}
      <div class="spread muted">
        <span>{z.lastTickAt ? <>Last checked <Time ts={z.lastTickAt} /></> : "Not checked yet"}</span>
        {z.activeActions > 0 && <Link href="/actions">View actions</Link>}
      </div>
    </section>
  );
}

export function Live() {
  const { data, error, loading } = useLoad(() => get<{ zones: Zone[] }>("/zones"), [], 30000);
  useTick(15000);
  return (
    <Page title="Live" lede="Requests per minute for each zone against its learned baseline. Refreshes every 30 seconds.">
      {loading && !data && <Loading what="zones" />}
      <ErrorText error={error} />
      {data && data.zones.length === 0 && <Empty title="No zones yet">Add a zone on the <Link href="/zones">Zones screen</Link> and its traffic will appear here.</Empty>}
      {data && <div class="cards">{data.zones.map((z) => <ZoneCard key={z.id} z={z} />)}</div>}
    </Page>
  );
}
