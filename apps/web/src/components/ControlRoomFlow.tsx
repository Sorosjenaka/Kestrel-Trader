// apps/web/src/components/ControlRoomFlow.tsx
//
// 30 Okt 2026 (koreksi operator poin 3): graph NETWORK digambar ulang sebagai
// SVG deterministik, bukan @xyflow/react. Alasan: React Flow 12.8 di bundel ini
// menerima 17 edge tapi tidak pernah menggambar satu pun (EdgeWrapper batal di
// tahap pengukuran handle) — hasilnya kotak hitam kosong. Graph ini:
//   - layout 8 stage × kolom, jarak tetap, tidak menumpuk,
//   - semua node & edge dihitung dari snapshot NYATA (/api/control/snapshot),
//   - di-fit ke container (viewBox + preserveAspectRatio), jadi tidak ada
//     "node kecil menumpuk" saat lebar panel berubah,
//   - READ-ONLY: klik node hanya membuka inspector.
import { useMemo } from "react";
import type { ControlActor, ControlSnapshot } from "../lib/controlRoomAdapter.js";

const STAGES = [
  ["SOURCES", ["binance-feed", "microstructure", "universe"]],
  ["SCANNER", ["scanner-supervisor", "scanner"]],
  ["ANALYSTS", ["macro-scout", "regime-analyst", "market-context", "signal-analyst", "funnel-analyst"]],
  ["THESIS ARENA", ["thesis-long", "thesis-short"]],
  ["REFEREE", ["thesis-referee"]],
  ["JUDGES", ["setup-judge", "drex"]],
  ["RISK", ["risk-officer", "daily-guard"]],
  ["EXEC · SUPERVISE", ["order-executor", "position-supervisor", "trade-supervisor", "watchdog-py"]],
] as const;

const FEEDBACK = ["trade-evaluator", "post-mortem", "strategy-tuner", "backtest-auditor", "narrator"] as const;

const tone: Record<ControlActor["status"], string> = {
  working: "#3AA8F2", idle: "#5C6890", waiting: "#9AB2E4", error: "#F2414A", noevidence: "#262A44",
};

const NODE_W = 188;
const NODE_H = 96;
const GAP_X = 36;
const GAP_Y = 18;
const PAD = 24;

interface Box { actor: ControlActor; x: number; y: number }

export function ControlRoomFlow({ snapshot, onSelect }: { snapshot: ControlSnapshot; onSelect: (actor: ControlActor) => void }) {
  const layout = useMemo(() => {
    const actors = new Map(snapshot.actors.map((a) => [a.id, a]));
    const boxes: Box[] = [];
    const byId = new Map<string, Box>();
    let rowCount = 0;
    STAGES.forEach(([, ids], stageIndex) => {
      ids.forEach((id, row) => {
        const actor = actors.get(id);
        if (!actor) return;
        const box: Box = { actor, x: PAD + stageIndex * (NODE_W + GAP_X), y: PAD + row * (NODE_H + GAP_Y) };
        boxes.push(box);
        byId.set(id, box);
        rowCount = Math.max(rowCount, row + 1);
      });
    });
    const flowBottom = PAD + rowCount * (NODE_H + GAP_Y);
    const feedbackBoxes: Box[] = [];
    FEEDBACK.forEach((id, index) => {
      const actor = actors.get(id);
      if (!actor) return;
      const box: Box = { actor, x: PAD + index * (NODE_W + GAP_X), y: flowBottom + 26 };
      feedbackBoxes.push(box);
      byId.set(id, box);
    });
    const width = PAD * 2 + STAGES.length * NODE_W + (STAGES.length - 1) * GAP_X;
    const height = Math.max(flowBottom + 26 + NODE_H + PAD, 260);
    return { boxes, feedbackBoxes, byId, width, height };
  }, [snapshot.actors]);

  const paths = useMemo(() => {
    const out: Array<{ id: string; d: string; active: boolean; feedback: boolean }> = [];
    const { byId } = layout;
    const cx = (b: Box, side: "l" | "r") => (side === "r" ? b.x + NODE_W : b.x);
    const cy = (b: Box) => b.y + NODE_H / 2;
    STAGES.slice(0, -1).forEach(([, ids], stageIndex) => {
      const next = STAGES[stageIndex + 1]![1];
      const targetId = next.find((id) => byId.has(id));
      if (!targetId) return;
      const target = byId.get(targetId)!;
      ids.filter((id) => byId.has(id)).forEach((id) => {
        const source = byId.get(id)!;
        const x1 = cx(source, "r"), y1 = cy(source);
        const x2 = cx(target, "l"), y2 = cy(target);
        const mid = Math.max(24, (x2 - x1) / 2);
        out.push({
          id: `${id}-${targetId}`,
          d: `M ${x1} ${y1} C ${x1 + mid} ${y1}, ${x2 - mid} ${y2}, ${x2} ${y2}`,
          active: source.actor.status === "working" && target.actor.status !== "idle",
          feedback: false,
        });
      });
    });
    // Loop pembelajaran (garis putus-putus) — hanya bila kedua ujung ada.
    const feedbackPairs: Array<[string, string]> = [
      ["trade-evaluator", "post-mortem"],
      ["post-mortem", "strategy-tuner"],
      ["strategy-tuner", "backtest-auditor"],
      ["trade-evaluator", "scanner-supervisor"],
    ];
    for (const [s, t] of feedbackPairs) {
      const source = byId.get(s), target = byId.get(t);
      if (!source || !target) continue;
      const x1 = cx(source, "r"), y1 = cy(source);
      const x2 = cx(target, "l"), y2 = cy(target);
      const low = Math.max(y1, y2) + 46;
      out.push({
        id: `${s}-${t}-feedback`,
        d: `M ${x1} ${y1} C ${x1 + 40} ${low}, ${x2 - 40} ${low}, ${x2} ${y2}`,
        active: false,
        feedback: true,
      });
    }
    return out;
  }, [layout]);

  return (
    <div className="cr-flow" data-node-count={layout.boxes.length + layout.feedbackBoxes.length} data-edge-count={paths.length}>
      <svg
        className="cr-flow-svg"
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Network agen dan sistem, read-only"
      >
        <defs>
          <marker id="cr-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#4A5A88" />
          </marker>
        </defs>
        {STAGES.map(([name], index) => (
          <text key={name} className="cr-flow-stage" x={PAD + index * (NODE_W + GAP_X)} y={12}>
            {name}
          </text>
        ))}
        {paths.map((p) => (
          <path
            key={p.id}
            d={p.d}
            className={`cr-edge${p.active ? " active" : ""}${p.feedback ? " feedback" : ""}`}
            markerEnd="url(#cr-arrow)"
          />
        ))}
        {layout.boxes.map((b) => (
          <foreignObject key={b.actor.id} x={b.x} y={b.y} width={NODE_W} height={NODE_H}>
            <button
              type="button"
              className={`flow-node ${b.actor.status}`}
              style={{ borderColor: tone[b.actor.status], width: "100%", height: "100%" }}
              onClick={() => onSelect(b.actor)}
              title={`${b.actor.name} · ${b.actor.role}`}
            >
              <span className="flow-node-title">
                <i style={{ background: tone[b.actor.status] }} />
                {b.actor.name}
                <small>{b.actor.model ?? "SYS"}</small>
              </span>
              <span className="flow-node-role">{b.actor.role}</span>
              <span className="flow-node-foot">
                <span style={{ color: tone[b.actor.status] }}>{b.actor.status === "noevidence" ? "NO EVIDENCE" : b.actor.status.toUpperCase()}</span>
                <b>{b.actor.calls60m}/60m</b>
              </span>
            </button>
          </foreignObject>
        ))}
        {layout.feedbackBoxes.length > 0 && (
          <text className="cr-flow-stage" x={PAD} y={layout.feedbackBoxes[0]!.y - 10}>
            LEARNING LOOP · FEEDBACK
          </text>
        )}
        {layout.feedbackBoxes.map((b) => (
          <foreignObject key={b.actor.id} x={b.x} y={b.y} width={NODE_W} height={NODE_H}>
            <button
              type="button"
              className={`flow-node ${b.actor.status}`}
              style={{ borderColor: tone[b.actor.status], width: "100%", height: "100%" }}
              onClick={() => onSelect(b.actor)}
              title={`${b.actor.name} · ${b.actor.role}`}
            >
              <span className="flow-node-title">
                <i style={{ background: tone[b.actor.status] }} />
                {b.actor.name}
                <small>{b.actor.model ?? "SYS"}</small>
              </span>
              <span className="flow-node-role">{b.actor.role}</span>
              <span className="flow-node-foot">
                <span style={{ color: tone[b.actor.status] }}>{b.actor.status === "noevidence" ? "NO EVIDENCE" : b.actor.status.toUpperCase()}</span>
                <b>{b.actor.calls60m}/60m</b>
              </span>
            </button>
          </foreignObject>
        ))}
      </svg>
    </div>
  );
}
