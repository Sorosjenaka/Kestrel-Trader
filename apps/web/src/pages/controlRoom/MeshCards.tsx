// apps/web/src/pages/controlRoom/MeshCards.tsx
// 29 Okt 2026 · Tahap 5 redesign Tema B — kartu per agen (READ-ONLY).
//
// Sama dengan tampilan "ARTATRADE OPS · MESH AGEN": status, model, calls
// 24h/60m, lastNote. Semua dari /api/live/mesh (via snapshot Control Room) —
// status hanya digambar aktif bila ada bukti (ACTIVE), NO_EVIDENCE tetap abu.
import { colors, fonts } from "../../theme.js";
import type { ControlActor, ControlSnapshot } from "../../lib/controlRoomAdapter.js";

const tone: Record<ControlActor["status"], string> = {
  working: colors.up, idle: colors.textDim, waiting: colors.sand,
  error: colors.down, noevidence: colors.borderLight,
};
const label: Record<ControlActor["status"], string> = {
  working: "ACTIVE", idle: "IDLE", waiting: "WAIT", error: "ERROR", noevidence: "NO EVIDENCE",
};

function ago(iso: string | null): string {
  if (!iso) return "·";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "·";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} dtk lalu`;
  if (s < 3600) return `${Math.round(s / 60)} mnt lalu`;
  return `${Math.round(s / 3600)} jam lalu`;
}

export function MeshCards({ snapshot, onSelect }: {
  snapshot: ControlSnapshot;
  onSelect: (actor: ControlActor) => void;
}) {
  const agents = snapshot.actors.filter((a) => a.kind === "agent");
  return (
    <section className="mesh-cards" aria-label="Mesh agen (read-only)">
      <div className="mesh-cards-head">
        <span className="control-section-label">ARTATRADE OPS · MESH AGEN</span>
        <span className="control-readonly">STATUS DARI BUKTI (EVENTLOG/DECISIONLOG), BUKAN KLAIM</span>
      </div>
      <div className="mesh-cards-grid">
        {agents.map((a) => (
          <button key={a.id} type="button" className="mesh-card" onClick={() => onSelect(a)}>
            <div className="mesh-card-top">
              <b>{a.name}</b>
              <span className="mesh-card-status" style={{ color: tone[a.status], borderColor: tone[a.status] }}>
                {label[a.status]}
              </span>
            </div>
            <div className="mesh-card-role">{a.role}{a.model ? ` · ${a.model}` : ""}</div>
            <div className="mesh-card-meta">
              <span>{a.calls24h} calls 24j</span>
              <span>{a.calls60m}/60m</span>
              <span>{ago(a.lastActiveAt)}</span>
            </div>
            <p className="mesh-card-note" style={{ fontFamily: fonts.mono }}>{a.lastNote ?? "Tidak ada catatan terakhir."}</p>
          </button>
        ))}
        {agents.length === 0 && (
          <div style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.textMuted, padding: 20 }}>
            memuat status agen…
          </div>
        )}
      </div>
    </section>
  );
}
