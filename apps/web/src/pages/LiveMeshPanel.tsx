// apps/web/src/pages/LiveMeshPanel.tsx — mesh mission-control untuk tab LIVE
// (27 Okt 2026, permintaan operator: "EDIT dashboard Live seperti di video ...
// gw bisa lihat semua proses sistem gw dan ai agent LLM gw semua bekerja serta
// ai agent Drex gw juga. gw ga mau ada kebohongan dari satu pun").
//
// ATURAN: semua angka/status datang dari /api/live/mesh (sumber nyata:
// EventLog/DecisionLog/watchdog_state.json/mirror). Agen tanpa bukti tampil
// NO_EVIDENCE — tidak pernah digambar "aktif". Animasi (titik paket di graf)
// hiasan visual saja; TIDAK mewakili data.
import { useEffect, useRef, useState } from "react";

export interface MeshAgentRow {
  id: string; name: string; role: string; model: string;
  evidence: string[]; calls24h: number; calls60m: number;
  lastActiveAt: string | null; lastNote: string | null;
  status: "ACTIVE" | "IDLE" | "NO_EVIDENCE";
}
export interface MeshProcessRow {
  id: string; name: string; kind: string;
  status: "OK" | "IDLE" | "STALE" | "UNAVAILABLE" | "OFF";
  detail: string; lastSeenAt: string | null;
}
interface MeshLogRow { at: string; actor: string; message: string; status: string; }
interface MeshFlowNode {
  id: string; label: string; metric: string; source: string;
  status: "OK" | "IDLE" | "WARN" | "UNAVAILABLE";
}
export interface LiveMeshReport {
  generatedAt: string; executionMode: string; armed: boolean;
  kpis: {
    agentsOnline: number; eventsPerMin: number;
    verified24h: number; rejected24h: number; skipped24h: number; note: string;
  };
  agents: MeshAgentRow[]; processes: MeshProcessRow[];
  flow: MeshFlowNode[]; log: MeshLogRow[];
  watchdog: {
    status: "OK" | "STALE" | "UNAVAILABLE"; stateFile: string;
    symbols: Array<{ symbol: string; phase: string; updatedAt: string | null }>;
    note: string;
  };
}

// Palet mission-control ala video (gelap, neon halus).
// Palet Tema B "X / ink" (29 Okt 2026): latar tinta kebiruan, aksen merah,
// profit cyan, loss merah. Hijau TIDAK dipakai.
const C = {
  bg: "#04050F", grid: "rgba(38,42,68,0.35)", card: "rgba(12,14,30,0.85)",
  border: "#262A44", text: "#DCE1F6", muted: "#5C6890",
  amber: "#D0628A", red: "#F2414A", green: "#3AA8F2", blue: "#3AA8F2",
  cyan: "#3AA8F2", purple: "#9AB2E4",
};
const mono = "'JetBrains Mono',ui-monospace,monospace";
const sans = "'Inter','Geist',system-ui,sans-serif";

const statusColor = (s: string): string =>
  s === "ACTIVE" || s === "OK" ? C.green
  : s === "IDLE" || s === "STALE" || s === "WARN" ? C.amber
  : s === "UNAVAILABLE" || s === "OFF" ? C.red
  : C.muted;

function ago(iso: string | null): string {
  if (!iso) return "·";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))} dtk lalu`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} menit lalu`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} jam lalu`;
  return `${Math.round(ms / 86_400_000)} hari lalu`;
}

// ── Graf alur (node nyata + paket animasi hiasan) ──────────────────────────
function FlowGraph({ flow }: { flow: MeshFlowNode[] }) {
  const w = 1180, h = 150;
  const n = flow.length;
  const gapX = w / (n + 1);
  const y = 58;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: 150, display: "block" }}>
      <defs>
        <linearGradient id="mesh-edge" x1="0" x2="1">
          <stop offset="0%" stopColor="rgba(255,255,255,0.18)" />
          <stop offset="100%" stopColor="rgba(255,255,255,0.42)" />
        </linearGradient>
      </defs>
      {flow.map((nd, i) => {
        const x = gapX * (i + 1);
        const nextX = i < n - 1 ? gapX * (i + 2) : null;
        return (
          <g key={nd.id}>
            {/* edge ke node berikutnya + paket animasi (hiasan) */}
            {nextX != null && (
              <>
                <path
                  id={`edge-${nd.id}`}
                  d={`M ${x + 62} ${y} C ${x + 110} ${y}, ${nextX - 110} ${y}, ${nextX - 62} ${y}`}
                  stroke="url(#mesh-edge)" strokeWidth="1.4" fill="none"
                />
                <circle r="2.6" fill={C.cyan} opacity="0.9">
                  <animateMotion dur={`${2.4 + i * 0.35}s`} repeatCount="indefinite" begin={`${i * 0.5}s`}>
                    <mpath href={`#edge-${nd.id}`} />
                  </animateMotion>
                </circle>
                <circle r="1.8" fill={C.amber} opacity="0.7">
                  <animateMotion dur={`${2.4 + i * 0.35}s`} repeatCount="indefinite" begin={`${i * 0.5 + 1.1}s`}>
                    <mpath href={`#edge-${nd.id}`} />
                  </animateMotion>
                </circle>
              </>
            )}
            <rect
              x={x - 62} y={y - 26} width={124} height={52} rx={8}
              fill={C.card} stroke={statusColor(nd.status)} strokeWidth="1.2"
            />
            <circle cx={x - 50} cy={y - 14} r="3.4" fill={statusColor(nd.status)} />
            <text x={x - 42} y={y - 10} fill={C.text} fontSize="9.5" fontFamily={mono} fontWeight="700">
              {nd.label.length > 19 ? nd.label.slice(0, 18) + "…" : nd.label}
            </text>
            <text x={x - 50} y={y + 8} fill={C.cyan} fontSize="10" fontFamily={mono}>
              {nd.metric.length > 24 ? nd.metric.slice(0, 23) + "…" : nd.metric}
            </text>
            <text x={x - 50} y={y + 20} fill={C.muted} fontSize="7.5" fontFamily={mono}>
              {nd.source.length > 28 ? nd.source.slice(0, 27) + "…" : nd.source}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ── Kartu agen ─────────────────────────────────────────────────────────────
function AgentCard({ a }: { a: MeshAgentRow }) {
  const col = statusColor(a.status);
  return (
    <div
      style={{
        background: C.card, borderRadius: 10, padding: "10px 12px",
        border: `1px solid ${a.status === "NO_EVIDENCE" ? C.border : col}`,
        boxShadow: a.status === "ACTIVE" ? `0 0 14px ${col}22` : "none",
        display: "flex", flexDirection: "column", gap: 6, minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span
          style={{
            width: 8, height: 8, borderRadius: "50%", background: col, flexShrink: 0,
            boxShadow: a.status === "ACTIVE" ? `0 0 8px ${col}` : "none",
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: C.text, fontFamily: sans, fontWeight: 700, fontSize: 13 }}>{a.name}</div>
          <div style={{ color: C.muted, fontFamily: mono, fontSize: 9.5 }}>{a.id}</div>
        </div>
        <span
          style={{
            fontFamily: mono, fontSize: 8.5, padding: "2px 6px", borderRadius: 3,
            border: `1px solid ${C.border}`, color: C.muted, letterSpacing: "0.06em",
          }}
        >
          {a.model}
        </span>
      </div>
      <div style={{ color: C.muted, fontFamily: mono, fontSize: 9.5, lineHeight: 1.5 }}>{a.role}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {a.evidence.length === 0 && (
          <span style={{ fontFamily: mono, fontSize: 8.5, color: C.muted, border: `1px dashed ${C.border}`, borderRadius: 3, padding: "2px 6px" }}>
            tidak ada bukti di EventLog
          </span>
        )}
        {a.evidence.map((ev) => (
          <span
            key={ev}
            style={{
              fontFamily: mono, fontSize: 8.5, color: C.cyan, background: "rgba(34,211,238,0.08)",
              border: "1px solid rgba(34,211,238,0.25)", borderRadius: 3, padding: "2px 6px",
            }}
          >
            {ev}
          </span>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 6, marginTop: "auto" }}>
        <span style={{ fontFamily: mono, fontSize: 9, color: col, fontWeight: 700 }}>
          {a.status === "NO_EVIDENCE" ? "TANPA BUKTI" : `${a.status} · ${ago(a.lastActiveAt)}`}
        </span>
        <span style={{ fontFamily: mono, fontSize: 9, color: C.muted }}>{a.calls24h}/24j</span>
      </div>
      {a.lastNote && (
        <div style={{ fontFamily: mono, fontSize: 8.5, color: C.muted, lineHeight: 1.5, borderTop: `1px solid ${C.border}`, paddingTop: 5 }}>
          {a.lastNote}
        </div>
      )}
    </div>
  );
}

export function LiveMeshPanel() {
  const [mesh, setMesh] = useState<LiveMeshReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (!alive || document.visibilityState === "hidden") { timer = setTimeout(load, 5000); return; }
      try {
        const r = await fetch("/api/live/mesh");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = (await r.json()) as LiveMeshReport;
        if (alive) { setMesh(d); setErr(null); }
      } catch (e) {
        if (alive) setErr((e as Error).message);
      }
      if (alive) timer = setTimeout(load, 5000);
    };
    load();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, []);

  return (
    <div
      style={{
        background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12,
        padding: 0, overflow: "hidden", position: "relative",
        backgroundImage:
          `linear-gradient(${C.grid} 1px, transparent 1px), linear-gradient(90deg, ${C.grid} 1px, transparent 1px)`,
        backgroundSize: "40px 40px",
      }}
    >
      {/* ── KPI strip · definisi jujur di bawahnya ── */}
      <div style={{ display: "flex", gap: 0, borderBottom: `1px solid ${C.border}`, background: "rgba(10,13,20,0.7)" }}>
        {[
          { v: mesh ? String(mesh.kpis.agentsOnline) : "…", l: "AGENTS ONLINE", col: C.text },
          { v: mesh ? String(mesh.kpis.eventsPerMin) : "…", l: "EVENT / MENIT", col: C.green },
          { v: mesh ? String(mesh.kpis.verified24h) : "…", l: "VERIFIED · GO 24J", col: C.cyan },
          { v: mesh ? String(mesh.kpis.rejected24h) : "…", l: "REJECTED · NO_GO 24J", col: C.red },
          { v: mesh ? String(mesh.kpis.skipped24h) : "…", l: "SKIPPED 24J", col: C.muted },
        ].map((k, i) => (
          <div key={k.l} style={{ flex: 1, padding: "12px 16px", borderLeft: i > 0 ? `1px solid ${C.border}` : undefined }}>
            <div style={{ fontFamily: sans, fontSize: 21, fontWeight: 800, color: k.col }}>{k.v}</div>
            <div style={{ fontFamily: mono, fontSize: 8.5, color: C.muted, letterSpacing: "0.08em" }}>{k.l}</div>
          </div>
        ))}
      </div>
      <div style={{ padding: "5px 16px", fontFamily: mono, fontSize: 8.5, color: C.muted, borderBottom: `1px solid ${C.border}` }}>
        definisi: {mesh?.kpis.note ?? "memuat…"}
      </div>

      {err && (
        <div style={{ padding: "8px 16px", fontFamily: mono, fontSize: 10, color: C.red }}>
          Gagal memuat /api/live/mesh: {err} · data TIDAK ditampilkan palsu.
        </div>
      )}

      {/* ── Graf alur & grid agen DIPINDAH ke tab NETWORK/GRID (Control Room
             digabung ke Live, 30 Okt 2026) supaya tidak tampil dua kali. ── */}

      {/* ── Proses ── */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", padding: "8px 16px", borderBottom: `1px solid ${C.border}` }}>
        {(mesh?.processes ?? []).map((p) => (
          <div
            key={p.id}
            style={{
              display: "flex", alignItems: "center", gap: 7, background: C.card,
              border: `1px solid ${statusColor(p.status)}`, borderRadius: 8, padding: "6px 10px",
              maxWidth: 340, minWidth: 220, flexGrow: 1,
            }}
            title={p.detail}
          >
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: statusColor(p.status), flexShrink: 0 }} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontFamily: mono, fontSize: 9.5, color: C.text, fontWeight: 700 }}>
                {p.name} <span style={{ color: statusColor(p.status) }}>{p.status}</span>
              </div>
              <div style={{ fontFamily: mono, fontSize: 8, color: C.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {p.detail}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* ── Watchdog Python (gap kritis: posisi di luar DB Node) ── */}
      {mesh && (
        <div style={{ padding: "10px 16px", borderBottom: `1px solid ${C.border}`, background: "rgba(245,166,35,0.05)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: statusColor(mesh.watchdog.status) }} />
            <span style={{ fontFamily: mono, fontSize: 10.5, color: C.text, fontWeight: 700, letterSpacing: "0.06em" }}>
              WATCHDOG PYTHON · POSISI DI LUAR DB NODE
            </span>
            <span style={{ fontFamily: mono, fontSize: 9, color: statusColor(mesh.watchdog.status) }}>{mesh.watchdog.status}</span>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
            {mesh.watchdog.symbols.map((s) => (
              <span
                key={s.symbol}
                style={{
                  fontFamily: mono, fontSize: 9, color: C.amber, background: "rgba(245,166,35,0.1)",
                  border: "1px solid rgba(245,166,35,0.35)", borderRadius: 4, padding: "3px 8px",
                }}
                title={`update terakhir: ${s.updatedAt ?? "·"}`}
              >
                {s.symbol} · {s.phase}
              </span>
            ))}
            {mesh.watchdog.symbols.length === 0 && (
              <span style={{ fontFamily: mono, fontSize: 9, color: C.muted }}>tidak ada simbol dipantau</span>
            )}
          </div>
          <div style={{ fontFamily: mono, fontSize: 8.5, color: C.muted, lineHeight: 1.6 }}>{mesh.watchdog.note}</div>
        </div>
      )}

      {/* ── Grid kartu agen pindah ke tab GRID (satu tampilan, tidak dobel) ── */}

      {/* ── Log console ── */}
      <div style={{ background: "rgba(8,11,17,0.95)" }}>
        <div style={{ padding: "7px 16px", fontFamily: mono, fontSize: 8.5, color: C.muted, letterSpacing: "0.12em", borderBottom: `1px solid ${C.border}` }}>
          LOG STREAM · 40 EVENTLOG TERAKHIR, APA ADANYA
        </div>
        <div ref={logRef} style={{ maxHeight: 190, overflowY: "auto", padding: "6px 0" }}>
          {(mesh?.log ?? []).map((l, i) => (
            <div
              key={`${l.at}-${i}`}
              style={{
                display: "flex", gap: 10, padding: "2.5px 16px", fontFamily: mono, fontSize: 9.5,
                lineHeight: 1.5, background: i % 2 ? "rgba(255,255,255,0.015)" : "transparent",
              }}
            >
              <span style={{ color: C.muted, flexShrink: 0 }}>{l.at.slice(11, 23)}</span>
              <span style={{ color: C.green, width: 130, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.actor}</span>
              <span style={{ color: C.text, flex: 1, minWidth: 0, opacity: 0.85 }}>{l.message}</span>
              <span style={{ color: l.status === "ok" ? C.green : l.status === "warn" ? C.amber : C.red, flexShrink: 0 }}>{l.status}</span>
            </div>
          ))}
          {!mesh && <div style={{ fontFamily: mono, fontSize: 10, color: C.muted, padding: "8px 16px" }}>memuat log…</div>}
        </div>
      </div>
    </div>
  );
}
