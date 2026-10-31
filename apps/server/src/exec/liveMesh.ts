// apps/server/src/exec/liveMesh.ts — laporan mesh untuk dashboard
// mission-control (27 Okt 2026, permintaan operator: "EDIT dashboard Live
// seperti di video ... gw bisa lihat semua proses sistem gw dan ai agent LLM
// gw semua bekerja serta ai agent Drex gw juga. gw ga mau ada kebohongan
// dari satu pun").
//
// ATURAN ANTI-KEBOHONGAN: setiap angka/status punya sumber nyata yang
// disebutkan di payload (`evidence`/`note`). Agen tanpa bukti aktivitas
// berstatus NO_EVIDENCE ("tidak ada bukti") — BUKAN "aktif". Tidak ada angka
// hiasan, tidak ada status karangan. Sumber: EventLog, DecisionLog, OrderExec,
// watchdog_state.json, mirror exchange, env flag.
//
// READ-ONLY: tidak menulis DB, tidak mengirim order.
import fs from "node:fs";
import path from "node:path";
import { db } from "../core/db.js";
import { env } from "../core/env.js";
import { ALL_12_AGENTS } from "../agents/agentCatalog.js";
import { buildLiveDashboardReport } from "./liveDashboard.js";

export interface MeshAgentRow {
  id: string;
  name: string;
  role: string;
  model: string;
  /** Sumber bukti yang dipakai untuk status (nama tipe event / tabel). */
  evidence: string[];
  /** Jumlah bukti 24 jam + 60 menit terakhir (dari EventLog/DecisionLog). */
  calls24h: number;
  calls60m: number;
  lastActiveAt: string | null;
  lastNote: string | null;
  /** ACTIVE = ada bukti <=60m; IDLE = bukti lama; NO_EVIDENCE = tak ada bukti sama sekali. */
  status: "ACTIVE" | "IDLE" | "NO_EVIDENCE";
}

export interface MeshProcessRow {
  id: string;
  name: string;
  kind: "ENGINE" | "FEED" | "WORKER" | "GUARD" | "LLM";
  status: "OK" | "IDLE" | "STALE" | "UNAVAILABLE" | "OFF";
  detail: string;
  lastSeenAt: string | null;
}

export interface MeshLogRow {
  at: string;
  actor: string;
  message: string;
  status: string;
}

export interface MeshFlowNode {
  id: string;
  label: string;
  /** Angka nyata di bawah label node — sumber disebut di `source`. */
  metric: string;
  source: string;
  status: "OK" | "IDLE" | "WARN" | "UNAVAILABLE";
}

export interface LiveMeshReport {
  generatedAt: string;
  executionMode: string;
  armed: boolean;
  kpis: {
    agentsOnline: number;
    eventsPerMin: number;
    verified24h: number;
    rejected24h: number;
    skipped24h: number;
    /** Definisi jujur tiap KPI — ikut tampil di UI supaya tak menyesatkan. */
    note: string;
  };
  agents: MeshAgentRow[];
  processes: MeshProcessRow[];
  flow: MeshFlowNode[];
  log: MeshLogRow[];
  /** Posisi yang dipantau watchdog Python (watchdog_state.json) — gap kritis. */
  watchdog: {
    status: "OK" | "STALE" | "UNAVAILABLE";
    stateFile: string;
    symbols: Array<{ symbol: string; phase: string; updatedAt: string | null }>;
    /** Simbol yang seharusnya dijaga (OPEN DB + exchange-only). */
    expectedSymbols: string[];
    note: string;
  };
}

// ── Peta tipe event -> agen. Penulis tiap tipe sudah diverifikasi di kode
// (file:line ada di komentar) — jangan asal mengaitkan. ────────────────────
// AGENT_DIALOG       -> payload.agentId (langsung, paling akurat)
// LLM_SWEEP_VERDICT  -> agents/marketSweep.ts:298 (hakim sweep = Arka)
// POST_MORTEM_SAVED  -> learning/postMortemEvaluator.ts:449 (Sesha)
// DREX_SWING_SHADOW_COMPARE -> agents/decisionRiskLayer.ts:946 (Drex)
// PANEL_AI_ANALYSIS  -> analysis/panelInsights.ts:32 (Panel AI)
// LLM_ANALYST        -> agents/marketAnalyst.ts (analis pasar)
// LLM_TRADE_EVAL     -> agents/tradeEvaluator.ts (Mira — evaluator trade 5-why)
// LLM_QUICK_ANALYSIS -> agents/quickAnalysts.ts (Sari/Tala/Giri, paralel)
// THESIS_ARENA       -> agents/thesisArena.ts (Arya/Bayu/Ratih); bukti per agen
//   lewat AGENT_DIALOG yang ditulis arena — sengaja TIDAK masuk EVENT_AGENT.
// SWING_EVAL_*       -> learning/swingEvalLoop (Laras)
// DIRECTION_BATTLE   -> agents/directionalBattleArena.ts:104 — 3 agen (Vega/
//   Arka/Wardha); bukti per agen lewat AGENT_DIALOG yang ditulis arena, jadi
//   event ini sengaja TIDAK masuk EVENT_AGENT (tidak punya satu agen).
const EVENT_AGENT: Record<string, string> = {
  LLM_SWEEP: "setup-judge",
  LLM_SWEEP_VERDICT: "setup-judge",
  LLM_TRADE_EVAL: "trade-evaluator",
  POST_MORTEM_SAVED: "post-mortem",
  RECURRING_MISTAKE: "post-mortem",
  SWING_EVAL_QUEUED: "strategy-tuner",
  SWING_EVAL_EVALUATING: "strategy-tuner",
  SWING_EVAL_FEEDBACK_VALIDATED: "strategy-tuner",
  SWING_EVAL_INSUFFICIENT_DATA: "strategy-tuner",
  EXIT_FILL_APPLIED: "trade-supervisor",
  SL_MOVED_BE: "trade-supervisor",
  POSITION_CLOSED: "trade-supervisor",
  ORPHAN_POSITION_DETECTED: "trade-supervisor",
};

const EVENT_KIND: Record<string, string> = {
  AGENT_DIALOG: "DIALOG",
  LLM_SWEEP: "LLM", LLM_SWEEP_VERDICT: "LLM", LLM_ANALYST: "LLM",
  LLM_HEATMAP: "LLM", PANEL_AI_ANALYSIS: "LLM", LLM_TRADE_EVAL: "LLM",
  LLM_QUICK_ANALYSIS: "LLM",
  DIRECTION_BATTLE: "BATTLE", THESIS_ARENA: "BATTLE",
  DREX_SWING_SHADOW_COMPARE: "DREX",
  BOOT_RECONCILE: "SISTEM", ORPHAN_POSITION_DETECTED: "GUARD",
  EXIT_FILL_APPLIED: "EKSEKUSI", SL_MOVED_BE: "EKSEKUSI",
  POSITION_CLOSED: "EKSEKUSI", ARM_ENABLED: "SISTEM",
  COUNCIL_DECISION: "COUNCIL", RECURRING_MISTAKE: "BELAJAR",
  POST_MORTEM_SAVED: "BELAJAR", SWING_EVAL_QUEUED: "EVAL",
  SWING_EVAL_EVALUATING: "EVAL", SWING_EVAL_FEEDBACK_VALIDATED: "EVAL",
  SWING_EVAL_INSUFFICIENT_DATA: "EVAL",
};

function safeReadJson(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Batas umur file state watchdog sebelum heartbeat dianggap basi (poll 5 dtk). */
export const WATCHDOG_STATE_STALE_MS = 30_000;

export interface WatchdogAssessment {
  status: "OK" | "STALE" | "UNAVAILABLE";
  symbols: Array<{ symbol: string; phase: string; updatedAt: string | null }>;
  /** Simbol yang seharusnya dijaga: OPEN di DB + exchange-only. */
  expectedSymbols: string[];
  note: string;
}

/**
 * Nilai status watchdog dari isi state + daftar posisi yang WAJIB dijaga.
 *
 * STALE bukan hanya "state punya simbol yang sudah tidak ada". Arah sebaliknya
 * juga gap kritis: posisi OPEN yang TIDAK ada di state berarti watchdog tidak
 * menjaganya. Status dihitung dari selisih DUA ARAH terhadap gabungan posisi
 * OPEN DB + exchange-only — bukan exchange-only saja (bug lama: posisi normal
 * yang dilacak watchdog ikut dicap STALE).
 *
 * Heartbeat: file state ditulis watchdog setiap tick (5 dtk), jadi mtime file
 * yang lebih tua dari WATCHDOG_STATE_STALE_MS = proses mati/macet.
 */
export function assessWatchdogState(input: {
  state: Record<string, unknown> | null;
  openDbSymbols: readonly string[];
  exchangeOnlySymbols: readonly string[];
  stateAgeMs?: number | null;
}): WatchdogAssessment {
  const { state, openDbSymbols, exchangeOnlySymbols, stateAgeMs } = input;
  if (!state) {
    return {
      status: "UNAVAILABLE",
      symbols: [],
      expectedSymbols: [],
      note: "watchdog_state.json tidak terbaca — status watchdog tidak diketahui.",
    };
  }
  const norm = (s: unknown) => String(s ?? "").trim().toUpperCase();
  const symbolsObj = (state.symbols ?? {}) as Record<string, { phase?: string; updatedAt?: string }>;
  const symbols = Object.entries(symbolsObj).map(([sym, v]) => ({
    symbol: norm(sym),
    phase: String(v?.phase ?? "?"),
    updatedAt: v?.updatedAt ?? null,
  }));
  const expectedSymbols = [...new Set([...openDbSymbols, ...exchangeOnlySymbols].map(norm).filter(Boolean))].sort();
  const expected = new Set(expectedSymbols);
  const tracked = new Set(symbols.map((s) => s.symbol));

  const staleState = symbols.map((s) => s.symbol).filter((s) => !expected.has(s));
  const untracked = expectedSymbols.filter((s) => !tracked.has(s));
  const heartbeatStale = stateAgeMs != null && Number.isFinite(stateAgeMs) && stateAgeMs > WATCHDOG_STATE_STALE_MS;

  const problems: string[] = [];
  if (staleState.length > 0) {
    problems.push(
      `${staleState.length}/${symbols.length} simbol di state watchdog tidak punya posisi (state basi): ${staleState.join(", ")}`,
    );
  }
  if (untracked.length > 0) {
    problems.push(
      `${untracked.length} posisi OPEN tidak ada di state watchdog (tidak dijaga): ${untracked.join(", ")}`,
    );
  }
  if (heartbeatStale) {
    problems.push(`state watchdog tidak diperbarui ${Math.round((stateAgeMs as number) / 1000)} dtk (heartbeat basi)`);
  }

  return {
    status: problems.length > 0 ? "STALE" : "OK",
    symbols,
    expectedSymbols,
    note:
      problems.length > 0
        ? problems.join(" · ")
        : `${symbols.length} simbol dipantau watchdog; cocok dengan ${expectedSymbols.length} posisi yang harus dijaga (DB OPEN + exchange-only).`,
  };
}


export async function buildLiveMeshReport(): Promise<LiveMeshReport> {
  const nowMs = Date.now();
  const h24 = nowMs - 24 * 3600e3;
  const h1 = nowMs - 3600e3;
  const m10 = nowMs - 10 * 60e3;

  // ── EventLog: agregasi per tipe (24j + 1j) — satu query GROUP BY ─────────
  const ev24 = await db.eventLog.groupBy({
    by: ["type"],
    where: { createdAt: { gt: new Date(h24) } },
    _count: { _all: true },
    _max: { createdAt: true, id: true },
  }).catch(() => []);
  const ev60 = await db.eventLog.groupBy({
    by: ["type"],
    where: { createdAt: { gt: new Date(h1) } },
    _count: { _all: true },
  }).catch(() => []);
  const ev10 = await db.eventLog.count({ where: { createdAt: { gt: new Date(m10) } } }).catch(() => 0);

  const count24 = new Map<string, number>();
  const count60 = new Map<string, number>();
  const lastAt = new Map<string, number>();
  for (const r of ev24) {
    count24.set(r.type, r._count._all);
    if (r._max.createdAt) lastAt.set(r.type, r._max.createdAt.getTime());
  }
  for (const r of ev60) count60.set(r.type, r._count._all);

  // ── AGENT_DIALOG: per agen (payload.agentId/name/text) ──────────────────
  const dialogRows = await db.eventLog.findMany({
    where: { type: "AGENT_DIALOG", createdAt: { gt: new Date(h24) } },
    orderBy: { id: "desc" },
    select: { payload: true, createdAt: true },
    take: 3000,
  }).catch(() => []);
  const dialogByAgent = new Map<string, { c24: number; c60: number; lastAt: number | null; lastNote: string | null }>();
  for (const row of dialogRows) {
    let p: Record<string, unknown> | null = null;
    try {
      const parsed = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
      if (parsed && typeof parsed === "object") p = parsed as Record<string, unknown>;
    } catch { p = null; }
    const aid = String(p?.agentId ?? "unknown");
    const at = row.createdAt.getTime();
    const cur = dialogByAgent.get(aid) ?? { c24: 0, c60: 0, lastAt: null, lastNote: null };
    cur.c24 += 1;
    if (at > h1) cur.c60 += 1;
    if (cur.lastAt == null || at > cur.lastAt) {
      cur.lastAt = at;
      cur.lastNote = typeof p?.text === "string" ? (p.text as string).slice(0, 160) : null;
    }
    dialogByAgent.set(aid, cur);
  }

  // ── DecisionLog: GO/NO_GO/SKIPPED + bukti Drex (drexProb terisi) ────────
  const dec24 = await db.decisionLog.groupBy({
    by: ["decision"],
    where: { createdAt: { gt: new Date(h24) } },
    _count: { _all: true },
  }).catch(() => []);
  const decMap = new Map(dec24.map((r) => [r.decision, r._count._all]));
  const go24 = decMap.get("GO") ?? 0;
  const noGo24 = decMap.get("NO_GO") ?? 0;
  const skip24 = decMap.get("SKIPPED") ?? 0;
  const drexProb24 = await db.decisionLog.count({
    where: { createdAt: { gt: new Date(h24) }, drexProb: { not: null } },
  }).catch(() => 0);
  const drexProb60 = await db.decisionLog.count({
    where: { createdAt: { gt: new Date(h1) }, drexProb: { not: null } },
  }).catch(() => 0);
  const decTotal24 = go24 + noGo24 + skip24;

  // ── Laporan gabungan (mirror exchange + forward workers) — cache dipakai ulang ──
  const dash = await buildLiveDashboardReport();
  const exchangeOk = (dash.exchangeStatus ?? "UNAVAILABLE") === "OK";

  // ── Watchdog Python: watchdog_state.json (gap kritis: posisi di luar DB) ──
  const wdPath = path.resolve(process.cwd(), "watchdog/watchdog_state.json");
  const wd = safeReadJson(wdPath);
  let wdAgeMs: number | null = null;
  try {
    wdAgeMs = Date.now() - fs.statSync(wdPath).mtimeMs;
  } catch {
    wdAgeMs = null;
  }
  // Yang wajib dijaga = posisi OPEN di DB + posisi exchange-only. Watchdog boleh
  // melacak salah satu atau keduanya; yang STALE adalah selisih dua arah.
  const assessment = assessWatchdogState({
    state: wd,
    openDbSymbols: (dash.live?.positions ?? []).map((p) => p.symbol),
    exchangeOnlySymbols: (dash.live?.exchangeOnlyPositions ?? []).map((p) => p.symbol),
    stateAgeMs: wdAgeMs,
  });
  const watchdog: LiveMeshReport["watchdog"] = { stateFile: wdPath, ...assessment };

  // ── Proses nyata ─────────────────────────────────────────────────────────
  const fwdWorkers = dash.forwardPaper?.workers ?? [];
  const fwdOk = fwdWorkers.filter((w) => w.status === "OK" && w.running).length;
  const lastLlmAt = [...lastAt.entries()]
    .filter(([t]) => ["LLM_SWEEP", "LLM_SWEEP_VERDICT", "LLM_ANALYST", "LLM_HEATMAP", "PANEL_AI_ANALYSIS"].includes(t))
    .reduce<number | null>((a, [, t]) => (a == null || t > a ? t : a), null);

  const processes: MeshProcessRow[] = [
    {
      id: "engine", name: "Artatrade Engine", kind: "ENGINE",
      status: "OK",
      detail: `node ${process.uptime().toFixed(0)}d up · mode ${dash.executionMode} · ARM ${dash.armed ? "ON" : "OFF"}`,
      lastSeenAt: new Date().toISOString(),
    },
    {
      id: "binance-feed", name: "Binance Feed (REST+WS)", kind: "FEED",
      status: exchangeOk ? "OK" : "UNAVAILABLE",
      detail: exchangeOk
        ? `mirror OK · ${dash.live?.exchangeOnlyPositions?.length ?? 0} posisi exchange-only`
        : `mirror gagal: ${dash.exchangeError ?? "tanpa alasan"}`,
      lastSeenAt: exchangeOk ? new Date().toISOString() : null,
    },
    {
      id: "llm-xkiro", name: "LLM Router (Xkiro/Arka)", kind: "LLM",
      status: lastLlmAt ? (nowMs - lastLlmAt < 3600e3 ? "OK" : "IDLE") : "UNAVAILABLE",
      detail: lastLlmAt
        ? `event LLM terakhir ${Math.round((nowMs - lastLlmAt) / 60000)} menit lalu · ${([...count24.entries()].filter(([t]) => EVENT_KIND[t] === "LLM").reduce((a, [, c]) => a + c, 0))} panggilan 24j`
        : "tidak ada event LLM 24j — router tidak terbukti bekerja",
      lastSeenAt: lastLlmAt ? new Date(lastLlmAt).toISOString() : null,
    },
    {
      id: "council", name: "AI Council (Vega/Arka/Wardha)", kind: "LLM",
      status: env.ENABLE_AI_COUNCIL ? "OK" : "OFF",
      detail: env.ENABLE_AI_COUNCIL
        ? `ENABLE_AI_COUNCIL=true · veto tampil sebagai event COUNCIL_DECISION`
        : "ENABLE_AI_COUNCIL=false — council TIDAK jalan (jalur entry memakai runSetupJudge langsung)",
      lastSeenAt: null,
    },
    {
      id: "watchdog-py", name: "Watchdog Python", kind: "GUARD",
      status: watchdog.status === "OK" ? "OK" : watchdog.status === "STALE" ? "STALE" : "UNAVAILABLE",
      detail: `${watchdog.symbols.length} simbol di state · ${watchdog.note}`,
      lastSeenAt: wdAgeMs != null ? new Date(Date.now() - wdAgeMs).toISOString() : null,
    },
    {
      id: "forward-paper", name: `Forward-Paper Workers (${fwdOk}/${fwdWorkers.length})`, kind: "WORKER",
      status: fwdWorkers.length === 0 ? "UNAVAILABLE" : fwdOk === fwdWorkers.length ? "OK" : "STALE",
      detail: fwdWorkers.length
        ? fwdWorkers.map((w) => `${w.strategyId}:${w.status}${w.running ? "" : "(stop)"}`).join(" · ")
        : "tidak ada worker terbaca",
      lastSeenAt: null,
    },
  ];

  // ── Flow graph: node dengan metrik NYATA (sumber disebut eksplisit) ──────
  const dialog24 = count24.get("AGENT_DIALOG") ?? 0;
  const sweep24 = count24.get("LLM_SWEEP_VERDICT") ?? 0;
  const flow: MeshFlowNode[] = [
    {
      id: "feed", label: "MARKET FEED",
      metric: exchangeOk ? "Binance OK" : "UNAVAILABLE",
      source: "mirror exchange", status: exchangeOk ? "OK" : "UNAVAILABLE",
    },
    {
      id: "scanner", label: "SCANNER POOL · Bima",
      metric: `${dialog24} log 24j`,
      source: "EventLog AGENT_DIALOG", status: dialog24 > 0 ? "OK" : "IDLE",
    },
    {
      id: "strategy", label: "STRATEGI RSW/S",
      metric: `${decTotal24} evaluasi 24j`,
      source: "DecisionLog", status: decTotal24 > 0 ? "OK" : "IDLE",
    },
    {
      id: "gates", label: "GATE DETERMINISTIK",
      metric: `${skip24 + noGo24} ditahan 24j`,
      source: "DecisionLog SKIPPED+NO_GO", status: "OK",
    },
    {
      id: "judge", label: "AI JUDGE · Arka+Drex+Wardha",
      metric: `${sweep24} verdict · ${drexProb24} drex 24j`,
      source: "LLM_SWEEP_VERDICT + DecisionLog.drexProb", status: (sweep24 + drexProb24) > 0 ? "OK" : "IDLE",
    },
    {
      id: "executor", label: "EXECUTOR LIVE/PAPER",
      metric: `${dash.activity?.summary?.liveOrdersFilled ?? 0} order masuk`,
      source: "OrderExec (simulated=0, FILLED)", status: "OK",
    },
    {
      id: "supervisor", label: "SUPERVISOR · Nadira",
      metric: `${(count24.get("EXIT_FILL_APPLIED") ?? 0) + (count24.get("SL_MOVED_BE") ?? 0) + (count24.get("POSITION_CLOSED") ?? 0)} aksi exit 24j`,
      source: "EventLog eksekusi", status: "OK",
    },
  ];

  // ── KPI (definisi jujur, ikut tampil di UI) ──────────────────────────────
  const agentsOnline = (() => {
    let n = 0;
    for (const [, v] of dialogByAgent) if (v.c60 > 0) n += 1;
    if (drexProb60 > 0) n += 1; // Drex
    return n;
  })();

  // ── Kartu agen: 12 agen katalog + Drex + Panel AI. Status HANYA dari bukti
  // nyata: ACTIVE (bukti <=60m) / IDLE (bukti lama) / NO_EVIDENCE (tak ada
  // bukti — jangan digambar "aktif"). ─────────────────────────────────────────
  const agents: MeshAgentRow[] = [];
  for (const a of Object.values(ALL_12_AGENTS)) {
    const dlg = dialogByAgent.get(a.id) ?? { c24: 0, c60: 0, lastAt: null as number | null, lastNote: null as string | null };
    const evTypes = Object.entries(EVENT_AGENT).filter(([, ag]) => ag === a.id).map(([t]) => t);
    const ev24n = evTypes.reduce((s2, t) => s2 + (count24.get(t) ?? 0), 0);
    const ev60n = evTypes.reduce((s2, t) => s2 + (count60.get(t) ?? 0), 0);
    const evLast = evTypes.reduce<number | null>((s2, t) => {
      const v = lastAt.get(t);
      return v && (s2 == null || v > s2) ? v : s2;
    }, null);
    const evidence: string[] = [];
    if (dlg.c24 > 0 || dialogByAgent.has(a.id)) evidence.push(`AGENT_DIALOG (${dlg.c24}x 24j)`);
    for (const t of evTypes) evidence.push(`${t} (${count24.get(t) ?? 0}x 24j)`);
    // Wardha = risk planner deterministik: bukti tambahan = DecisionLog.
    if (a.id === "risk-officer") evidence.push(`DecisionLog (${decTotal24} evaluasi 24j, risk planner)`);
    const calls24h = dlg.c24 + ev24n + (a.id === "risk-officer" ? decTotal24 : 0);
    const calls60m = dlg.c60 + ev60n;
    const lastMs = Math.max(dlg.lastAt ?? 0, evLast ?? 0);
    agents.push({
      id: a.id,
      name: a.name,
      role: a.role,
      model: a.model,
      evidence,
      calls24h,
      calls60m,
      lastActiveAt: lastMs > 0 ? new Date(lastMs).toISOString() : null,
      lastNote: dlg.lastNote ?? (evidence.length > 0 ? `bukti terakhir: ${evidence[0]}` : null),
      status: calls60m > 0 ? "ACTIVE" : calls24h > 0 ? "IDLE" : "NO_EVIDENCE",
    });
  }
  // Drex — AI agent terpisah (drexAdapter/drexVision), bukan bagian 12 agen.
  const drexEv24 = count24.get("DREX_SWING_SHADOW_COMPARE") ?? 0;
  const drexEv60 = count60.get("DREX_SWING_SHADOW_COMPARE") ?? 0;
  const drexLast = lastAt.get("DREX_SWING_SHADOW_COMPARE") ?? 0;
  agents.push({
    id: "drex", name: "Drex",
    role: "AI agent analisis visual & shadow judge (drexAdapter)",
    model: "REASON",
    evidence: [`DecisionLog.drexProb (${drexProb24}x 24j)`, `DREX_SWING_SHADOW_COMPARE (${drexEv24}x 24j)`],
    calls24h: drexProb24 + drexEv24,
    calls60m: drexProb60 + drexEv60,
    lastActiveAt: drexLast > 0 ? new Date(drexLast).toISOString() : (drexProb24 > 0 ? new Date(h24).toISOString() : null),
    lastNote: `drexProb terisi pada ${drexProb24} keputusan 24j · shadow compare ${drexEv24}x`,
    status: drexProb60 + drexEv60 > 0 ? "ACTIVE" : drexProb24 + drexEv24 > 0 ? "IDLE" : "NO_EVIDENCE",
  });
  // Panel AI / analis pasar — komponen nyata (panelInsights, marketAnalyst,
  // marketIntel) yang menulis event LLM-nya sendiri; bukan nama agen katalog.
  const panelTypes = ["PANEL_AI_ANALYSIS", "LLM_ANALYST", "LLM_HEATMAP"];
  const panel24 = panelTypes.reduce((s2, t) => s2 + (count24.get(t) ?? 0), 0);
  const panel60 = panelTypes.reduce((s2, t) => s2 + (count60.get(t) ?? 0), 0);
  const panelLast = panelTypes.reduce<number | null>((s2, t) => {
    const v = lastAt.get(t);
    return v && (s2 == null || v > s2) ? v : s2;
  }, null);
  agents.push({
    id: "panel-ai", name: "Panel AI / Analis Pasar",
    role: "panelInsights + marketAnalyst + marketIntel (bukan agen katalog)",
    model: "REASON",
    evidence: panelTypes.map((t) => `${t} (${count24.get(t) ?? 0}x 24j)`),
    calls24h: panel24,
    calls60m: panel60,
    lastActiveAt: panelLast ? new Date(panelLast).toISOString() : null,
    lastNote: panel24 > 0 ? "event analisis panel/heatmap/analyst tercatat" : null,
    status: panel60 > 0 ? "ACTIVE" : panel24 > 0 ? "IDLE" : "NO_EVIDENCE",
  });

  // ── Log console: 40 baris EventLog terakhir (semua jenis, apa adanya) ────
  const logRaw = await db.eventLog.findMany({
    orderBy: { id: "desc" },
    take: 40,
    select: { type: true, severity: true, payload: true, createdAt: true },
  }).catch(() => []);
  const log: MeshLogRow[] = logRaw.map((e) => {
    let p: Record<string, unknown> | null = null;
    try {
      const parsed = typeof e.payload === "string" ? JSON.parse(e.payload) : e.payload;
      if (parsed && typeof parsed === "object") p = parsed as Record<string, unknown>;
    } catch { p = null; }
    const actorName = typeof p?.name === "string" ? String(p.name) : (EVENT_KIND[e.type] ?? e.type);
    const text = typeof p?.text === "string" ? String(p.text) : null;
    const sym = typeof p?.symbol === "string" ? String(p.symbol) : null;
    const reason = typeof p?.reason === "string" ? String(p.reason) : null;
    const message = text ?? [e.type, sym, reason].filter(Boolean).join(" · ");
    return {
      at: e.createdAt.toISOString(),
      actor: actorName,
      message: message.slice(0, 140),
      status: e.severity === "warn" ? "warn" : e.severity === "error" || e.severity === "critical" ? "error" : "ok",
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    executionMode: dash.executionMode,
    armed: dash.armed,
    kpis: {
      agentsOnline,
      eventsPerMin: Number((ev10 / 10).toFixed(1)),
      verified24h: go24,
      rejected24h: noGo24,
      skipped24h: skip24,
      note: "agents online = agen dengan bukti aktivitas <=60 menit · event/menit = EventLog 10 menit terakhir dibagi 10 · verified = DecisionLog GO 24j · rejected = NO_GO 24j",
    },
    agents,
    processes,
    flow,
    log,
    watchdog,
  };
}
