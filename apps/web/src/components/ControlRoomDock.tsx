import { useEffect, useState } from "react";
import { colors, fonts } from "../theme.js";
import type { ControlActor, ControlGroup, ControlSnapshot, ControlStatus } from "../lib/controlRoomAdapter.js";

const groups: ControlGroup[] = ["RESEARCH", "DECISION", "SUPERVISE", "LEARNING", "NARRATIVE", "SYSTEM"];
const tone: Record<ControlStatus, string> = { working: "#3AA8F2", idle: "#5C6890", waiting: "#9AB2E4", error: "#F2414A", noevidence: "#262A44" };
const label: Record<ControlStatus, string> = { working: "WORKING", idle: "IDLE", waiting: "WAITING", error: "ERROR", noevidence: "NO EVIDENCE" };

function Glyph({ actor, size = 28 }: { actor: ControlActor; size?: number }) {
  const first = actor.name.slice(0, 1).toUpperCase();
  return <span className="cr-glyph" style={{ width: size, height: size, borderColor: tone[actor.status], color: actor.kind === "agent" ? "#DCE1F6" : tone[actor.status] }} aria-hidden>{actor.kind === "agent" ? first : "⌁"}</span>;
}

export function ControlRoomDock({ snapshot, onSelect }: { snapshot: ControlSnapshot | null; onSelect: (actor: ControlActor) => void }) {
  const [paused, setPaused] = useState(false);
  useEffect(() => { const onVis = () => setPaused(document.visibilityState === "hidden"); document.addEventListener("visibilitychange", onVis); return () => document.removeEventListener("visibilitychange", onVis); }, []);
  const actors = snapshot?.actors ?? [];
  return <section className={`control-dock${paused ? " paused" : ""}`} aria-label="Control Room actor dock">
    {groups.map((group) => <div className="control-group" key={group}>
      <div className="control-group-label">{group === "SYSTEM" ? "SISTEM" : group} · {actors.filter((a) => a.group === group).length}</div>
      <div className="control-tokens">{actors.filter((a) => a.group === group).map((actor) => <button className="control-token" key={actor.id} title={`${actor.name} · ${label[actor.status]}`} onClick={() => onSelect(actor)}>
        <span className={`control-ring ${actor.status}`} style={{ borderTopColor: tone[actor.status] }}><Glyph actor={actor} size={28} /></span><span>{actor.name}</span><i style={{ background: tone[actor.status] }} />
      </button>)}</div>
    </div>)}
  </section>;
}

export function ControlRoomInspector({ actor, onClose }: { actor: ControlActor | null; onClose: () => void }) {
  if (!actor) return null;
  return <aside className="control-inspector" role="dialog" aria-label={`${actor.name} inspector`}>
    <div className="inspector-header"><Glyph actor={actor} size={48} /><div><div className="inspector-kicker">{actor.kind === "agent" ? `AGEN · ${actor.group}` : "SISTEM"} · {actor.id}</div><h2>{actor.name}</h2><p>{actor.role}{actor.model ? ` · ${actor.model}` : ""}</p></div><button className="inspector-close" onClick={onClose}>ESC ×</button></div>
    <div className="inspector-body">
      <section className="inspector-section"><div className="inspector-section-title">SEDANG MENGERJAKAN <span>{label[actor.status]}</span></div><div className="inspector-now" style={{ borderColor: tone[actor.status] }}>{actor.lastNote ?? "Tidak ada aktivitas tercatat."}</div></section>
      <section className="inspector-section"><div className="inspector-section-title">HEALTH <span>BUKTI API</span></div><div className="inspector-grid"><div><small>CALLS 60M</small><b>{actor.calls60m}</b></div><div><small>CALLS 24J</small><b>{actor.calls24h}</b></div><div><small>LAST ACTIVE</small><b>{actor.lastActiveAt ? new Date(actor.lastActiveAt).toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" }) : "·"}</b></div><div><small>STATUS</small><b style={{ color: tone[actor.status] }}>{label[actor.status]}</b></div></div></section>
      <section className="inspector-section"><div className="inspector-section-title">EVIDENCE / SOURCE</div><div className="inspector-source">{actor.evidence.length ? actor.evidence.map((x) => <div key={x}>› {x}</div>) : "Tidak ada bukti di EventLog / DecisionLog."}<div className="source-caption">{actor.source}</div></div></section>
    </div>
  </aside>;
}
