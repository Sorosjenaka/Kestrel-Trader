// apps/web/src/components/ControlRoomSection.tsx
//
// 30 Okt 2026 (koreksi operator poin 3): Control Room DIGABUNG ke halaman Live.
// Isi lama halaman Control Room (NETWORK flow, GRID, LACAK TRADE, inspector,
// live activity, MeshCards, watchdog) dipindah ke sini sebagai satu section;
// tab-nya dikendalikan header OPS di halaman Live (components/LiveOpsHeader).
//
// ATURAN KERAS: READ-ONLY. Nol tombol mutasi (semua fetch GET). JEDA hanya
// menghentikan auto-refresh/animasi UI — BUKAN menjeda bot.
import { useCallback, useEffect, useMemo, useState } from "react";
import { ControlRoomDock, ControlRoomInspector } from "./ControlRoomDock.js";
import { ControlRoomFlow } from "./ControlRoomFlow.js";
import { fetchControlSnapshot, type ControlActor, type ControlEvent, type ControlSnapshot } from "../lib/controlRoomAdapter.js";
import { LacakTrade } from "../pages/controlRoom/LacakTrade.js";
import { MeshCards } from "../pages/controlRoom/MeshCards.js";

export type ControlView = "network" | "grid" | "lacak";

const color = (actor: ControlActor | undefined) => actor?.status === "working" ? "#3AA8F2" : actor?.status === "waiting" ? "#9AB2E4" : actor?.status === "error" ? "#F2414A" : "#5C6890";

/** Filter feed sesuai brief bagian 8. */
const FEED_FILTERS = ["SEMUA", "AGEN", "SISTEM", "LLM", "TRACE", "KEPUTUSAN", "ERROR"] as const;
type FeedFilter = (typeof FEED_FILTERS)[number];

function matchFilter(event: ControlEvent, filter: FeedFilter, actorKind: (id: string) => "agent" | "system"): boolean {
  switch (filter) {
    case "SEMUA": return true;
    case "AGEN": return actorKind(event.actorId) === "agent";
    case "SISTEM": return actorKind(event.actorId) === "system";
    case "LLM": return /LLM/i.test(event.type) || /\bLLM\b/i.test(event.message);
    case "TRACE": return Boolean(event.traceId);
    case "KEPUTUSAN": return /DECISION|VERDICT|THESIS_ARENA|DIRECTION_BATTLE/i.test(event.type);
    case "ERROR": return event.severity === "error" || event.severity === "critical";
  }
}

function Activity({ snapshot, onSelect, paused }: { snapshot: ControlSnapshot; onSelect: (a: ControlActor) => void; paused: boolean }) {
  const [filter, setFilter] = useState<FeedFilter>("SEMUA");
  const [actorSel, setActorSel] = useState<string>("all");
  const byId = new Map(snapshot.actors.map((a) => [a.id, a]));
  const kindOf = (id: string): "agent" | "system" => byId.get(id)?.kind ?? "agent";
  // Aktor yang benar-benar punya event (untuk select).
  const actorOptions = useMemo(() => {
    const ids = new Set<string>();
    for (const e of snapshot.events) ids.add(e.actorId);
    return [...ids].sort();
  }, [snapshot.events]);
  const shown = useMemo(() => snapshot.events
    .filter((e) => matchFilter(e, filter, kindOf))
    .filter((e) => actorSel === "all" || e.actorId === actorSel)
    .slice(-40)
    .reverse(),
    [snapshot.events, filter, actorSel]); // eslint-disable-line react-hooks/exhaustive-deps
  return <section className="control-activity"><div className="control-section-label"><span>LIVE ACTIVITY</span><span>{snapshot.events.length} EVENTLOG</span></div>
    <div className="control-feed-tools" role="group" aria-label="Filter feed">
      {FEED_FILTERS.map((f) => (
        <button key={f} type="button" className={`feed-chip${filter === f ? " active" : ""}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f}</button>
      ))}
      <select value={actorSel} onChange={(e) => setActorSel(e.target.value)} aria-label="Pilih aktor" className="feed-actor-select">
        <option value="all">semua aktor</option>
        {actorOptions.map((id) => <option key={id} value={id}>{id}</option>)}
      </select>
    </div>
    {paused && <div className="control-jeda-note">JEDA · feed &amp; animasi berhenti (bot tetap jalan)</div>}
    <div className="control-events">{shown.map((event) => <button className={`control-event ${event.severity}`} key={event.id} onClick={() => { const a = byId.get(event.actorId); if (a) onSelect(a); }}><time>{new Date(event.at).toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" })}</time><b>{event.actor}</b><span className="event-type">{event.type}</span><p>{event.message}</p>{event.traceId && <code>{event.traceId}</code>}</button>)}
      {shown.length === 0 && <div className="control-loading">Tidak ada event untuk filter ini.</div>}
    </div>
  </section>;
}

export function ControlRoomSection({ view, onView }: { view: ControlView; onView: (v: ControlView) => void }) {
  const [snapshot, setSnapshot] = useState<ControlSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ControlActor | null>(null);
  // JEDA = berhenti auto-refresh + animasi UI. BUKAN menjeda bot.
  const [paused, setPaused] = useState(false);
  const [lacakTarget, setLacakTarget] = useState<string>("");

  // Tombol LACAK TRADE dari halaman Live menitipkan simbol via sessionStorage.
  useEffect(() => {
    try {
      const t = sessionStorage.getItem("artatrade.lacak");
      if (t) {
        setLacakTarget(t);
        onView("lacak");
        sessionStorage.removeItem("artatrade.lacak");
      }
    } catch { /* storage disabled */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async () => { try { setSnapshot(await fetchControlSnapshot()); setError(null); } catch (e) { setError(e instanceof Error ? e.message : "Control Room unavailable"); } }, []);
  useEffect(() => {
    if (paused) return;
    void load();
    const id = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 5000);
    return () => window.clearInterval(id);
  }, [load, paused]);

  const emptySnapshot: ControlSnapshot = { generatedAt: "", executionMode: "", armed: false, kpis: { agentsOnline: 0, eventsPerMin: 0, verified24h: 0, rejected24h: 0, skipped24h: 0, note: "" }, actors: [], processes: [], events: [], watchdog: { status: "UNAVAILABLE", stateFile: "", symbols: [], note: "" } };
  const snap = snapshot ?? emptySnapshot;

  return <div className="control-room-section">
    <div className="control-room-tools">
      <span className="control-readonly">READ-ONLY · TANPA TRADE / ARM / FLATTEN</span>
      <span className="control-section-hint">animasi = event baru, bukan data · sumber /api/control/snapshot</span>
      <div style={{ flex: 1 }} />
      <button aria-pressed={paused} title="Jeda: hentikan auto-refresh & animasi UI (bot tetap jalan)" onClick={() => setPaused((p) => !p)}>{paused ? "▶ LANJUT" : "❚❚ JEDA"}</button>
      <button onClick={() => void load()}>REFRESH</button>
    </div>
    {error && <div className="control-error">{error} · status tidak digambar sebagai aktif tanpa bukti.</div>}
    <div className="control-legend" aria-label="Legenda">
      <span><i className="dot working" /> WORKING</span>
      <span><i className="dot waiting" /> WAITING</span>
      <span><i className="dot idle" /> IDLE</span>
      <span><i className="dot error" /> ERROR</span>
      <span className="legend-flow">DATA FLOW</span>
      <span className="legend-feedback">FEEDBACK</span>
      <span className="legend-note">animasi = event baru, bukan data</span>
    </div>
    <div className="control-kpis">{[[String(snapshot?.kpis.agentsOnline ?? "·"), "AGENTS ONLINE"], [String(snapshot?.kpis.eventsPerMin ?? "·"), "EVENT / MENIT"], [String(snapshot?.kpis.verified24h ?? "·"), "VERIFIED · GO 24J"], [String(snapshot?.kpis.rejected24h ?? "·"), "REJECTED · NO_GO 24J"], [String(snapshot?.kpis.skipped24h ?? "·"), "SKIPPED 24J"]].map(([v, l]) => <div key={l}><b>{v}</b><span>{l}</span></div>)}</div>
    {view === "lacak" ? (
      <LacakTrade snapshot={snap} target={lacakTarget} onChangeTarget={setLacakTarget} onClose={() => onView("network")} />
    ) : (
      <main className="control-main"><div className="control-main-left">{snapshot && (view === "network" ? <ControlRoomFlow snapshot={snapshot} onSelect={setSelected} /> : <div className="control-grid-view">{snapshot.actors.map((a) => <button key={a.id} onClick={() => setSelected(a)}><b>{a.name}</b><span>{a.role}</span><i style={{ background: color(a) }}>{a.status.toUpperCase()}</i></button>)}</div>)}{!snapshot && <div className="control-loading"><span className="page-loading-bar" /> MEMUAT CONTROL ROOM…</div>}</div><Activity snapshot={snap} onSelect={setSelected} paused={paused} /></main>
    )}
    <MeshCards snapshot={snap} onSelect={setSelected} />
    <ControlRoomDock snapshot={snapshot} onSelect={setSelected} /><ControlRoomInspector actor={selected} onClose={() => setSelected(null)} />
  </div>;
}
