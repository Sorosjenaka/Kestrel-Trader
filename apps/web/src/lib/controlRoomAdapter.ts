import type { LiveMeshReport } from "../pages/LiveMeshPanel.js";

export type ControlStatus = "working" | "idle" | "waiting" | "error" | "noevidence";
export type ControlGroup = "RESEARCH" | "DECISION" | "SUPERVISE" | "LEARNING" | "NARRATIVE" | "SYSTEM";

export interface ControlActor {
  id: string;
  name: string;
  role: string;
  model?: string;
  group: ControlGroup;
  kind: "agent" | "system";
  status: ControlStatus;
  calls60m: number;
  calls24h: number;
  lastActiveAt: string | null;
  lastNote: string | null;
  evidence: string[];
  source: string;
}

export interface ControlEvent {
  id: string;
  at: string;
  actorId: string;
  actor: string;
  type: string;
  severity: string;
  message: string;
  traceId: string | null;
  symbol?: string;
}

export interface ControlSnapshot {
  generatedAt: string;
  executionMode: string;
  armed: boolean;
  kpis: LiveMeshReport["kpis"];
  actors: ControlActor[];
  processes: LiveMeshReport["processes"];
  events: ControlEvent[];
  watchdog: LiveMeshReport["watchdog"];
}

const AGENT_GROUPS: Record<string, ControlGroup> = {
  "macro-scout": "RESEARCH", "universe-curator": "RESEARCH", "regime-analyst": "RESEARCH",
  "scanner-supervisor": "RESEARCH", "market-context": "RESEARCH", "signal-analyst": "RESEARCH", "funnel-analyst": "RESEARCH",
  "setup-judge": "DECISION", "risk-officer": "DECISION", "thesis-long": "DECISION", "thesis-short": "DECISION", "thesis-referee": "DECISION",
  "trade-supervisor": "SUPERVISE", watchdog: "SUPERVISE",
  "post-mortem": "LEARNING", "strategy-tuner": "LEARNING", "backtest-auditor": "LEARNING", "trade-evaluator": "LEARNING",
  narrator: "NARRATIVE",
};

const SYSTEM_NAMES: Record<string, string> = {
  "binance-feed": "Binance WS", "microstructure": "Microstructure", universe: "Universe",
  scanner: "Scanner Pool", drex: "DREX Judge", "llm-xkiro": "Xkiro", "llm-deepseek": "DeepSeek",
  "order-executor": "Order Executor", "position-supervisor": "Position Supervisor", reconciler: "Reconciler",
  "watchdog-py": "Watchdog Python", "daily-guard": "Daily Guard / ARM", db: "SQLite DB", api: "API / nginx",
};

function mapAgentStatus(status: string): ControlStatus {
  return status === "ACTIVE" ? "working" : status === "IDLE" ? "idle" : "noevidence";
}
function mapProcessStatus(status: string): ControlStatus {
  return status === "OK" ? "working" : status === "STALE" ? "waiting" : status === "UNAVAILABLE" ? "error" : "idle";
}
function parsePayload(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") { try { const v = JSON.parse(raw); return v && typeof v === "object" ? v : {}; } catch { return {}; } }
  return {};
}

// 30 Okt 2026 (B2, perintah operator): baris PAPER dibuang dari Control Room —
// hanya event LIVE yang tampil. Penanda paper: id order simulasi PX_ (dibuat
// supervisor PAPER, positionSupervisor.ts) dan jenis event exit virtual
// supervisor (EXIT_FILL_APPLIED/SL_MOVED_BE/POSITION_CLOSED). Jalur LIVE memakai
// jenis terpisah: LIVE_POSITION_CLOSED / SL_MOVED_BE_LIVE.
const PAPER_EVENT_TYPES = new Set(["EXIT_FILL_APPLIED", "EXIT_NOT_FILLED", "SL_MOVED_BE", "POSITION_CLOSED"]);
export function isPaperEvent(row: Record<string, unknown>, payload: Record<string, unknown>): boolean {
  const raw = typeof row.payload === "string" ? row.payload : "";
  const cid = typeof payload.clientOrderId === "string" ? payload.clientOrderId : "";
  return PAPER_EVENT_TYPES.has(String(row.type ?? "")) || cid.startsWith("PX_") || raw.includes("\"PX_");
}

export function adaptMesh(mesh: LiveMeshReport, events: Array<Record<string, unknown>> = []): ControlSnapshot {
  const actors: ControlActor[] = mesh.agents.map((a) => ({
    id: a.id, name: a.name, role: a.role, model: a.model,
    group: AGENT_GROUPS[a.id] ?? "RESEARCH", kind: "agent", status: mapAgentStatus(a.status),
    calls60m: a.calls60m, calls24h: a.calls24h, lastActiveAt: a.lastActiveAt,
    lastNote: a.lastNote, evidence: a.evidence, source: "/api/live/mesh → agents",
  }));
  const processes: ControlActor[] = mesh.processes.map((p) => ({
    id: p.id, name: SYSTEM_NAMES[p.id] ?? p.name, role: p.detail, group: "SYSTEM", kind: "system",
    status: mapProcessStatus(p.status), calls60m: 0, calls24h: 0, lastActiveAt: p.lastSeenAt,
    lastNote: p.detail, evidence: [], source: "/api/live/mesh → processes",
  }));
  const adapted: ControlEvent[] = events
    // B2: baris paper tidak tampil (hanya LIVE).
    .filter((row) => !isPaperEvent(row, parsePayload(row.payload)))
    .map((row, index) => {
    const p = parsePayload(row.payload);
    const agentId = typeof p.agentId === "string" ? p.agentId : typeof row.type === "string" ? row.type : "api";
    return {
      id: String(row.id ?? `${row.createdAt ?? "event"}-${index}`),
      at: String(row.createdAt ?? new Date().toISOString()), actorId: agentId,
      actor: typeof p.name === "string" ? p.name : agentId, type: String(row.type ?? "EVENT"),
      severity: String(row.severity ?? "info"), message: String(p.text ?? p.summary ?? p.message ?? row.type ?? "EVENT"),
      traceId: typeof p.traceId === "string" ? p.traceId : null,
      symbol: typeof p.symbol === "string" ? p.symbol : undefined,
    };
  });
  return { generatedAt: mesh.generatedAt, executionMode: mesh.executionMode, armed: mesh.armed, kpis: mesh.kpis, actors: [...actors, ...processes], processes: mesh.processes, events: adapted, watchdog: mesh.watchdog };
}

export async function fetchControlSnapshot(): Promise<ControlSnapshot> {
  const [meshRes, eventsRes] = await Promise.all([
    fetch("/api/live/mesh", { cache: "no-store" }),
    fetch("/api/events?limit=100", { cache: "no-store" }),
  ]);
  if (!meshRes.ok) throw new Error(`/api/live/mesh HTTP ${meshRes.status}`);
  const mesh = await meshRes.json() as LiveMeshReport;
  const eventsBody = eventsRes.ok ? await eventsRes.json() as { events?: Array<Record<string, unknown>> } : { events: [] };
  return adaptMesh(mesh, Array.isArray(eventsBody.events) ? eventsBody.events : []);
}
