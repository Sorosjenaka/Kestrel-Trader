// apps/server/src/exec/liveDashboard.ts — dashboard gabungan LIVE + PAPER
// (27 Okt 2026, perintah operator: "tambahkan juga fitur Live atau dashboard
// Live agar gw bisa lihat langsung jadi nya ada paper yang terus berjalan dan
// Live berjalan terus juga").
//
// READ-ONLY: modul ini tidak pernah mengirim order, tidak pernah menulis DB.
// Gagal membaca suatu sumber = field ditandai UNAVAILABLE + alasan, bukan
// angka nol palsu (fail-closed, pola yang sama dengan liveMirror.ts).
//
// Tiga sumber, sengaja dipisah supaya tidak tercampur:
//   1. LANE LIVE    — posisi/order nyata di exchange Binance + baris DB
//                     bersumber LIVE_*. Slot/margin/PnL dihitung dari ini.
//   2. LANE PAPER   — posisi simulasi di DB utama bersumber PAPER_*. Tidak
//                     ada di exchange; tampil terpisah supaya operator bisa
//                     melihat paper "jalan" tanpa tercampur dengan live.
//   3. FORWARD PAPER — worker riset terisolasi (port 8791..8795), masing-masing
//                     punya wallet sendiri. DILAPORKAN TERPISAH, tidak boleh
//                     dijumlahkan ke wallet manapun (lihat foreground-worker
//                     invariant di swingEvalLoop: forward wallet terpisah).
import { db } from "../core/db.js";
import { env } from "../core/env.js";
import { logger } from "../core/logger.js";
import { defaultDailyRiskGuard } from "../risk/dailyGuard.js";
import { START_EQUITY_USD } from "../risk/riskEngine.js";
import { buildLiveMirrorReport, type LiveMirrorReport } from "./liveMirror.js";
import { createInFlightCache } from "./inFlightCache.js";

// ── Tipe lane ──────────────────────────────────────────────────────────────
export type LaneId = "LIVE" | "PAPER" | "FORWARD_PAPER";

export interface LanePositionRow {
  id: number;
  symbol: string;
  side: string;
  mode: string;
  qty: number;
  entryPrice: number;
  slPrice: number;
  tp1Price: number;
  /** TP2 (kalau ada) — dipakai chart untuk menampilkan level kedua. */
  tp2Price: number | null;
  notional: number;
  marginUsd: number;
  leverage: number;
  unrealizedPnlUsd: number | null;
  strategyId: string | null;
  openedAt: string;
  source: string;
}

export interface LaneTradeRow {
  id: number;
  symbol: string;
  side: string;
  mode: string;
  pnlUsd: number;
  rMultiple: number;
  feeUsd: number;
  win: boolean;
  closeReason: string | null;
  strategyId: string | null;
  createdAt: string;
  source: string;
}

export interface LaneStats {
  /** Status sumber: OK | UNAVAILABLE. */
  status: "OK" | "UNAVAILABLE";
  error?: string;
  openPositions: number;
  maxPositions: number;
  closedTrades: number;
  winRatePct: number | null;
  netPnlUsd: number;
  /** Equity milik lane ini SAJA (tidak dijumlah dengan lane lain). */
  equityUsd: number;
  unrealizedPnlUsd: number;
  /** Entry terakhir di lane ini (ISO) — dasar untuk Age. */
  lastEntryAt: string | null;
  /** Trade tertutup terakhir di lane ini (ISO). */
  lastTradeAt: string | null;
  positions: LanePositionRow[];
  trades: LaneTradeRow[];
  /**
   * Posisi yang ADA di exchange tapi BELUM punya baris di DB (mis. service
   * restart tepat setelah fill, sehingga insert Position terlewat). Posisi
   * seperti ini TIDAK terlacak supervisor, jadi harus terlihat eksplisit.
   */
  exchangeOnlyPositions: ExchangeOnlyPosition[];
}

/** Posisi di exchange tanpa baris DB — level SL/TP diambil dari algo order. */
export interface ExchangeOnlyPosition {
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  entryPrice: number;
  markPrice: number | null;
  leverage: string | null;
  marginType: string | null;
  /** Level SL dari algo order (SLA_*) — null kalau tidak terpasang. */
  slPrice: number | null;
  /** Level TP dari algo order (TPA_ / TPB_) — null kalau tidak terpasang. */
  tpPrices: number[];
  /** true = tidak ada baris Position di DB (belum ter-track supervisor). */
  untracked: boolean;
}

export interface ForwardWorkerRow {
  strategyId: string;
  port: number;
  status: "OK" | "UNAVAILABLE";
  error?: string;
  running: boolean;
  liveEnabled: boolean;
  equityUsd: number | null;
  cashUsd: number | null;
  reservedMarginUsd: number | null;
  initialBalanceUsd: number | null;
  maxPositions: number | null;
  trades: number | null;
  winRatePct: number | null;
  netPnlUsd: number | null;
  openPositions: number;
  lastCycleAt: number | null;
  bankrupt: boolean;
  errors: string[];
}

export interface LiveActivityRow {
  id: number;
  kind: "ORDER" | "POSITION" | "EVENT";
  symbol: string;
  side: string | null;
  type: string | null;
  status: string;
  qty: number | null;
  price: number | null;
  /** true = order benar-benar dieksekusi exchange (bukan simulasi). */
  live: boolean;
  source: string | null;
  at: string;
  detail: string | null;
}

export interface LiveDashboardReport {
  generatedAt: string;
  executionMode: "PAPER" | "LIVE";
  armed: boolean;
  canTrade: boolean;
  guardReasons: string[];
  /** Saldo wallet exchange (hanya terisi di mode LIVE + key tersedia). */
  exchangeBalanceUsd: number | null;
  exchangeAvailableUsd: number | null;
  exchangeStatus: "OK" | "UNAVAILABLE";
  exchangeError?: string;
  /**
   * Lane mana yang SEDANG menerima entry baru. Mode global menentukan
   * prefix source saat entry (plannedEntry.ts: `PAPER_` / `LIVE_`), jadi di
   * mode LIVE lane PAPER di DB utama TIDAK menambah posisi baru — paper yang
   * terus berjalan adalah worker forward-paper (proses terpisah, mode PAPER).
   * Tanpa penanda ini operator bisa salah baca "paper jalan" padahal beku.
   */
  entryActivity: {
    /** Prefix source yang dipakai entry baru saat ini. */
    activePrefix: "PAPER" | "LIVE";
    /** Lane di DB utama yang menerima entry baru. */
    activeDbLane: "live" | "paper";
    /** true = lane PAPER (DB utama) frozen: tidak ada entry baru sejak go-live. */
    paperDbLaneFrozen: boolean;
    /** Keterangan singkat untuk UI. */
    note: string;
  };
  live: LaneStats;
  paper: LaneStats;
  forwardPaper: {
    status: "OK" | "UNAVAILABLE";
    error?: string;
    workers: ForwardWorkerRow[];
  };
  /**
   * Aktivitas LIVE terbaru (order executed + posisi live + event guard).
   * Dipakai UI untuk auto-refresh + alert: sumber kebenaran "ada apa saja
   * yang terjadi di exchange/ledger live sejak tick terakhir".
   */
  activity: {
    status: "OK" | "UNAVAILABLE";
    error?: string;
    /** Order live (simulated=0) terbaru, terbaru dulu. */
    orders: LiveActivityRow[];
    /** Posisi LIVE (source LIVE_*) yang dibuka/ditutup, terbaru dulu. */
    positions: LiveActivityRow[];
    /** Event log ber-severity warn/error yang relating ke live. */
    events: LiveActivityRow[];
    /** Ringkasan angka untuk badge: berapa order live filled, berapa ditolak. */
    summary: {
      /** SEMUA order live yang pernah dikirim ke exchange (termasuk NEW/CANCELED). */
      liveOrdersTotal: number;
      /** Order live yang BENAR-BENAR MASUK (terisi) = "order masuk". */
      liveOrdersFilled: number;
      /** Order live yang dibatalkan / ditolak exchange. */
      liveOrdersCanceled: number;
      /** Order live yang masih menggantung di book (LIMIT NEW, belum terisi). */
      liveOrdersOpen: number;
      /** Order live yang ditolak / gagal. */
      liveOrdersRejected: number;
      livePositionsTotal: number;
      livePositionsOpen: number;
      /** Order live TERAKHIR yang MASUK (FILLED) — sumber alert "order masuk". */
      lastLiveOrderAt: string | null;
      /** Order live terakhir yang MASUK (FILLED) — symbol/side/qty-nya. */
      lastFilledOrder: {
        id: number; symbol: string; side: string | null;
        type: string | null; qty: number | null; price: number | null; at: string;
      } | null;
    };
  };
  /** Mirror DB-vs-exchange per posisi (HANYA_DB / BEDA_QTY / HANYA_EXCHANGE). */
  mirror: LiveMirrorReport;
}

// ── Worker forward-paper (research-only, terisolasi) ──────────────────────
// Port tetap mengikuti tools/run-swing-research-paper.mjs (lihat systemd
// unit artatrade-swing-paper*.service). Kalau worker mati, lane ini hanya
// melaporkan UNAVAILABLE — tidak boleh menjatuhkan lane LIVE/PAPER.
const FORWARD_WORKERS: Array<{ strategyId: string; port: number }> = [
  { strategyId: "S-05", port: 8795 },
  { strategyId: "RSW-01", port: 8792 },
  { strategyId: "RSW-02", port: 8793 },
  { strategyId: "RSW-03", port: 8794 },
  { strategyId: "FORWARD_COMBINED", port: 8791 },
];

const WORKER_TIMEOUT_MS = 2500;

// ── Cache (proteksi rate-limit exchange) ────────────────────────────────────
// HANYA panggilan SIGNED ke exchange (buildLiveMirrorReport: balance,
// positionRisk, openOrders, openAlgoOrders) yang di-cache. Data activity
// (order/posisi/event dari DB) TIDAK di-cache supaya alert order live baru
// tetap muncul dalam hitungan detik, bukan tertunda TTL.
//
// Cache pendek (20 dtk) + in-flight sharing: beberapa tab browser yang poll
// bersamaan tidak menggandakan call ke exchange, dan request yang tumpang
// tindih tidak dijalankan dua kali.
const REPORT_CACHE_TTL_MS = 20_000;
// 30 Okt 2026 — fix /api/live/dashboard & /api/live/mesh hang. Sebelumnya
// cache in-flight ditulis manual (mirrorInFlight + .finally untuk reset).
// .finally() hanya jalan saat promise settle; bila buildLiveMirrorReport()
// pernah menggantung, mirrorInFlight teracuni permanen dan semua request
// berikutnya ikut menggantung (lihat inFlightCache.ts). Kini memakai
// createInFlightCache: fetch dibungkus timeout sehingga SELALU settle, maka
// slot in-flight pasti dibebaskan — sistem self-healing.
const MIRROR_TIMEOUT_MS = 15_000;
const getMirrorCachedRaw = createInFlightCache<LiveMirrorReport>(buildLiveMirrorReport, {
  ttlMs: REPORT_CACHE_TTL_MS,
  timeoutMs: MIRROR_TIMEOUT_MS,
  label: "buildLiveMirrorReport",
});

/** Mirror exchange dengan cache TTL + in-flight sharing + timeout keras. */
async function getMirrorCached(): Promise<LiveMirrorReport> {
  return getMirrorCachedRaw();
}

async function fetchForwardWorker(worker: { strategyId: string; port: number }): Promise<ForwardWorkerRow> {
  const base: ForwardWorkerRow = {
    strategyId: worker.strategyId,
    port: worker.port,
    status: "UNAVAILABLE",
    running: false,
    liveEnabled: false,
    equityUsd: null,
    cashUsd: null,
    reservedMarginUsd: null,
    initialBalanceUsd: null,
    maxPositions: null,
    trades: null,
    winRatePct: null,
    netPnlUsd: null,
    openPositions: 0,
    lastCycleAt: null,
    bankrupt: false,
    errors: [],
  };
  try {
    const res = await fetch(`http://127.0.0.1:${worker.port}/status`, {
      signal: AbortSignal.timeout(WORKER_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP_${res.status}`);
    const d = (await res.json()) as Record<string, unknown>;
    const metrics = (d.metrics ?? {}) as Record<string, unknown>;
    const positions = Array.isArray(d.positions) ? (d.positions as unknown[]) : [];
    const errs = Array.isArray(d.errors) ? (d.errors as unknown[]).map((e) => String(e)) : [];
    return {
      ...base,
      status: "OK",
      error: undefined,
      running: Boolean(d.running),
      liveEnabled: Boolean(d.liveEnabled),
      equityUsd: typeof d.equityUsd === "number" ? d.equityUsd : null,
      cashUsd: typeof d.cashUsd === "number" ? d.cashUsd : null,
      reservedMarginUsd: typeof d.reservedMarginUsd === "number" ? d.reservedMarginUsd : null,
      initialBalanceUsd: typeof d.initialBalanceUsd === "number" ? d.initialBalanceUsd : null,
      maxPositions: typeof d.maxPositions === "number" ? d.maxPositions : null,
      trades: typeof metrics.trades === "number" ? metrics.trades : null,
      winRatePct: typeof metrics.winratePct === "number" ? metrics.winratePct : null,
      netPnlUsd: typeof metrics.netPnl === "number" ? metrics.netPnl : null,
      openPositions: positions.length,
      lastCycleAt: typeof d.lastCycleAt === "number" ? d.lastCycleAt : null,
      bankrupt: Boolean(d.bankrupt),
      errors: errs,
    };
  } catch (err) {
    return { ...base, error: (err as Error)?.message ?? "UNAVAILABLE" };
  }
}

// ── Hitung PnL unrealized dari mark price live (hub harga) ────────────────
function unrealizedFor(
  pos: { side: string; entryPrice: number; qty: number },
  mark: number | null,
): number | null {
  if (mark == null || !Number.isFinite(mark) || mark <= 0) return null;
  const isLong = pos.side === "LONG";
  return Number(((isLong ? mark - pos.entryPrice : pos.entryPrice - mark) * pos.qty).toFixed(4));
}

/**
 * Posisi yang ada di exchange tapi belum punya baris Position di DB.
 * Sumber: snapshot exchange (positionRisk) + algo order (SL/TP resting).
 * Memakai algo order sebagai sumber level SL/TP karena exchange tidak
 * menyimpan SL/TP di positionRisk.
 */
function detectExchangeOnlyPositions(
  mirror: LiveMirrorReport | null,
  dbLiveSymbols: Set<string>,
): ExchangeOnlyPosition[] {
  if (!mirror || mirror.exchange.status !== "OK") return [];
  // Klasifikasi level dari PREFIX clientAlgoId yang kita pasang sendiri:
  // SLA_ = stop-loss, TPA_/TPB_ = take-profit (konvensi bracketCleanup.ts:155).
  // Jangan tebak dari harga — heuristik harga terbukti TERBALIK (SL/TP tertukar
  // di SKYUSDT 27 Okt: SL 0.05822 di bawah entry SHORT, padahal SL asli 0.06722).
  // Fallback bila prefix tak dikenal: posisi LONG -> SL di bawah entry, SHORT ->
  // SL di atas entry (arah benar menurut sisi posisi).
  interface AlgoLevel { trigger: number; kind: "SL" | "TP" | "UNKNOWN"; }
  const algoBySymbol = new Map<string, AlgoLevel[]>();
  for (const a of mirror.exchange.openAlgoOrders ?? []) {
    if (a.algoStatus !== "NEW") continue;
    const sym = String(a.symbol ?? "").toUpperCase();
    const trigger = Number(a.triggerPrice);
    if (!sym || !Number.isFinite(trigger) || trigger <= 0) continue;
    const cid = String(a.clientAlgoId ?? "").toUpperCase();
    const kind: AlgoLevel["kind"] = cid.startsWith("SL") ? "SL" : cid.startsWith("TP") ? "TP" : "UNKNOWN";
    const list = algoBySymbol.get(sym) ?? [];
    list.push({ trigger, kind });
    algoBySymbol.set(sym, list);
  }
  const out: ExchangeOnlyPosition[] = [];
  for (const p of mirror.exchange.positions ?? []) {
    const sym = String(p.symbol ?? "").toUpperCase();
    const amt = Number(p.positionAmt);
    if (!sym || !Number.isFinite(amt) || amt === 0) continue;
    if (dbLiveSymbols.has(sym)) continue; // sudah punya baris DB
    const levels = algoBySymbol.get(sym) ?? [];
    const isLong = amt > 0;
    const entry = Number(p.entryPrice ?? 0);
    let sl: number | null = null;
    const tps: number[] = [];
    for (const lv of levels) {
      let k = lv.kind;
      if (k === "UNKNOWN") {
        // Fallback arah-posisi: SL berada di sisi LOSS.
        k = isLong ? (lv.trigger < entry ? "SL" : "TP") : (lv.trigger > entry ? "SL" : "TP");
      }
      if (k === "SL" && sl == null) sl = lv.trigger;
      else tps.push(lv.trigger);
    }
    out.push({
      symbol: sym,
      side: isLong ? "LONG" : "SHORT",
      qty: Math.abs(amt),
      entryPrice: entry,
      markPrice: Number.isFinite(Number(p.markPrice)) ? Number(p.markPrice) : null,
      leverage: p.leverage ?? null,
      marginType: p.marginType ?? null,
      slPrice: sl,
      tpPrices: tps,
      untracked: true,
    });
  }
  return out;
}

// ── Lane LIVE: posisi source LIVE_* ───────────────────────────────────────
async function buildLiveLane(): Promise<LaneStats> {
  const positions = await db.position.findMany({
    where: { status: "OPEN", source: { startsWith: "LIVE_" } },
    orderBy: { openedAt: "desc" },
  });
  const trades = await db.trade.findMany({
    where: { source: { startsWith: "LIVE_" } },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { position: { select: { closeReason: true } } },
  });
  const netPnl = trades.reduce((a, t) => a + t.pnlUsd, 0);
  const wins = trades.filter((t) => t.win).length;
  return {
    status: "OK",
    openPositions: positions.length,
    maxPositions: Math.max(1, Number(env.LIVE_MAX_OPEN_POSITIONS ?? 1)),
    closedTrades: trades.length,
    winRatePct: trades.length > 0 ? Number(((wins / trades.length) * 100).toFixed(2)) : null,
    netPnlUsd: Number(netPnl.toFixed(4)),
    equityUsd: 0,
    unrealizedPnlUsd: 0,
    lastEntryAt: positions.length > 0 ? positions[0].openedAt.toISOString() : null,
    lastTradeAt: trades.length > 0 ? trades[0].createdAt.toISOString() : null,
    exchangeOnlyPositions: [],
    positions: positions.map((p) => ({
      id: p.id, symbol: p.symbol, side: p.side, mode: p.mode, qty: p.qty,
      entryPrice: p.entryPrice, slPrice: p.slPrice, tp1Price: p.tp1Price,
      tp2Price: p.tp2Price ?? null,
      notional: p.notional, marginUsd: p.marginUsd, leverage: p.leverage,
      unrealizedPnlUsd: null, strategyId: p.strategyId,
      openedAt: p.openedAt.toISOString(), source: p.source,
    })),
    trades: trades.map((t) => ({
      id: t.id, symbol: t.symbol, side: t.side, mode: t.mode, pnlUsd: t.pnlUsd,
      rMultiple: t.rMultiple, feeUsd: t.feeUsd, win: t.win,
      closeReason: t.position?.closeReason ?? null,
      strategyId: t.strategyId, createdAt: t.createdAt.toISOString(), source: t.source ?? "UNKNOWN",
    })),
  };
}

// ── Lane PAPER: posisi simulasi di DB utama (source PAPER_*) ──────────────
async function buildPaperLane(): Promise<LaneStats> {
  const positions = await db.position.findMany({
    where: { status: "OPEN", source: { startsWith: "PAPER_" } },
    orderBy: { openedAt: "desc" },
  });
  const trades = await db.trade.findMany({
    where: { source: { startsWith: "PAPER_" } },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { position: { select: { closeReason: true } } },
  });
  const netPnl = trades.reduce((a, t) => a + t.pnlUsd, 0);
  const wins = trades.filter((t) => t.win).length;
  return {
    status: "OK",
    openPositions: positions.length,
    maxPositions: 20,
    closedTrades: trades.length,
    winRatePct: trades.length > 0 ? Number(((wins / trades.length) * 100).toFixed(2)) : null,
    netPnlUsd: Number(netPnl.toFixed(4)),
    equityUsd: 0,
    unrealizedPnlUsd: 0,
    lastEntryAt: positions.length > 0 ? positions[0].openedAt.toISOString() : null,
    lastTradeAt: trades.length > 0 ? trades[0].createdAt.toISOString() : null,
    exchangeOnlyPositions: [],
    positions: positions.map((p) => ({
      id: p.id, symbol: p.symbol, side: p.side, mode: p.mode, qty: p.qty,
      entryPrice: p.entryPrice, slPrice: p.slPrice, tp1Price: p.tp1Price,
      tp2Price: p.tp2Price ?? null,
      notional: p.notional, marginUsd: p.marginUsd, leverage: p.leverage,
      unrealizedPnlUsd: null, strategyId: p.strategyId,
      openedAt: p.openedAt.toISOString(), source: p.source,
    })),
    trades: trades.map((t) => ({
      id: t.id, symbol: t.symbol, side: t.side, mode: t.mode, pnlUsd: t.pnlUsd,
      rMultiple: t.rMultiple, feeUsd: t.feeUsd, win: t.win,
      closeReason: null, strategyId: t.strategyId,
      createdAt: t.createdAt.toISOString(), source: t.source ?? "UNKNOWN",
    })),
  };
}

// ── PnL unrealized per lane (mark price dari hub Binance) ─────────────────
function attachUnrealized(lane: LaneStats, marks: Map<string, number>): number {
  let total = 0;
  lane.positions = lane.positions.map((p) => {
    const u = unrealizedFor(p, marks.get(p.symbol) ?? null);
    if (u != null) total += u;
    return { ...p, unrealizedPnlUsd: u };
  });
  lane.unrealizedPnlUsd = Number(total.toFixed(4));
  return total;
}

// ── Aktivitas LIVE: order executed, posisi live, event guard ───────────────
/**
 * Sumber kebenaran "apa yang terjadi di live lately". READ-ONLY.
 * - orders: OrderExec simulated=0 (order benar-benar dikirim ke exchange).
 * - positions: Position source LIVE_* (dibuka / ditutup).
 * - events: EventLog severity warn/error (guard, loss tripwire, dll).
 *
 * Kegagalan satu sumber TIDAK menggagalkan yang lain: tiap bagian punya
 * status sendiri, dan bagian yang gagal diisi [] + error (bukan angka nol
 * palsu yang terlihat seperti "tidak ada aktivitas").
 */
async function buildLiveActivity(): Promise<LiveDashboardReport["activity"]> {
  const empty = {
    status: "UNAVAILABLE" as const,
    error: "ACTIVITY_QUERY_FAILED",
    orders: [] as LiveActivityRow[],
    positions: [] as LiveActivityRow[],
    events: [] as LiveActivityRow[],
    summary: {
      liveOrdersTotal: 0, liveOrdersFilled: 0, liveOrdersCanceled: 0,
      liveOrdersOpen: 0, liveOrdersRejected: 0,
      livePositionsTotal: 0, livePositionsOpen: 0, lastLiveOrderAt: null as string | null,
      lastFilledOrder: null as LiveDashboardReport["activity"]["summary"]["lastFilledOrder"],
    },
  };

  const [orders, positions, events, counts] = await Promise.all([
    db.orderExec.findMany({
      where: { simulated: false },
      orderBy: { id: "desc" },
      take: 20,
    }).catch(() => null),
    db.position.findMany({
      where: { source: { startsWith: "LIVE_" } },
      orderBy: { id: "desc" },
      take: 20,
    }).catch(() => null),
    db.eventLog.findMany({
      // Feed LIVE-only: buang noise refleksi/analisis agen (RECURRING_MISTAKE,
      // post-mortem, dialog LLM) — itu milik panel aktivitas agen, bukan status
      // operasi live. Yang tersisa = event guard/orphan/purge yang menyangkut
      // exposure nyata.
      where: {
        severity: { in: ["warn", "error", "critical"] },
        type: {
          notIn: [
            "RECURRING_MISTAKE", "POST_MORTEM_SAVED", "AGENT_DIALOG",
            "PANEL_AI_ANALYSIS", "LLM_SWEEP", "LLM_SWEEP_VERDICT",
            "LLM_ANALYST", "LLM_HEATMAP", "DREX_SWING_SHADOW_COMPARE",
          ],
        },
      },
      orderBy: { id: "desc" },
      take: 20,
    }).catch(() => null),
    db.orderExec.count({ where: { simulated: false } }).catch(() => null),
  ]);

  if (orders === null && positions === null && events === null) return empty;

  const orderRows: LiveActivityRow[] = (orders ?? []).map((o) => ({
    id: o.id,
    kind: "ORDER",
    symbol: o.symbol,
    side: o.side,
    type: o.type,
    status: o.status,
    qty: o.filledQty ?? o.qty,
    price: o.fillPrice ?? o.price,
    live: true,
    source: null,
    at: (o.filledAt ?? o.createdAt).toISOString(),
    detail: o.reduceOnly ? "reduce-only" : null,
  }));

  const positionRows: LiveActivityRow[] = (positions ?? []).map((p) => ({
    id: p.id,
    kind: "POSITION",
    symbol: p.symbol,
    side: p.side,
    type: p.strategyId ?? null,
    status: p.status,
    qty: p.qty,
    price: p.entryPrice,
    live: true,
    source: p.source,
    at: (p.closedAt ?? p.openedAt).toISOString(),
    detail: p.closeReason ?? p.strategyId ?? null,
  }));

  // EventLog.payload bertipe String (JSON string), bukan objek. Parse aman:
  // payload rusak / bukan JSON = null (bukan error fatal untuk seluruh feed).
  const eventRows: LiveActivityRow[] = (events ?? []).map((e) => {
    let payload: Record<string, unknown> | null = null;
    try {
      const parsed = typeof e.payload === "string" ? JSON.parse(e.payload) : e.payload;
      if (parsed && typeof parsed === "object") payload = parsed as Record<string, unknown>;
    } catch {
      payload = null;
    }
    const sym = payload?.symbol;
    const reason = payload?.reason;
    return {
      id: e.id,
      kind: "EVENT",
      symbol: typeof sym === "string" ? sym : "—",
      side: null,
      type: e.type,
      status: e.severity,
      qty: null,
      price: null,
      live: true,
      source: null,
      at: e.createdAt.toISOString(),
      detail: typeof reason === "string" ? reason : null,
    };
  });

  // Ringkasan: hitung sekali (bukan dari list yang sudah dipotong).
  // "ORDER MASUK" = order live berstatus FILLED (benar-benar terisi di
  // exchange). Order NEW (masih resting di book) dan CANCELED/REJECTED
  // dihitung terpisah supaya angka "masuk" tidak tercampur.
  const [filled, canceled, open, rejected, posTotal, posOpen] = await Promise.all([
    db.orderExec.count({ where: { simulated: false, status: "FILLED" } }).catch(() => 0),
    db.orderExec.count({ where: { simulated: false, status: "CANCELED" } }).catch(() => 0),
    db.orderExec.count({ where: { simulated: false, status: "NEW" } }).catch(() => 0),
    db.orderExec.count({ where: { simulated: false, status: "REJECTED" } }).catch(() => 0),
    db.position.count({ where: { source: { startsWith: "LIVE_" } } }).catch(() => 0),
    db.position.count({ where: { source: { startsWith: "LIVE_" }, status: "OPEN" } }).catch(() => 0),
  ]);

  // Order live terakhir yang MASUK: pakai filledAt (bukan createdAt) supaya
  // waktunya = waktu order benar-benar terisi.
  const lastFilledRow = await db.orderExec.findFirst({
    where: { simulated: false, status: "FILLED" },
    orderBy: { id: "desc" },
  }).catch(() => null);
  const lastFilledOrder = lastFilledRow
    ? {
        id: lastFilledRow.id,
        symbol: lastFilledRow.symbol,
        side: lastFilledRow.side,
        type: lastFilledRow.type,
        qty: lastFilledRow.filledQty ?? lastFilledRow.qty,
        price: lastFilledRow.fillPrice ?? lastFilledRow.price,
        at: (lastFilledRow.filledAt ?? lastFilledRow.createdAt).toISOString(),
      }
    : null;

  return {
    status: "OK",
    error: undefined,
    orders: orderRows,
    positions: positionRows,
    events: eventRows,
    summary: {
      liveOrdersTotal: counts ?? orderRows.length,
      liveOrdersFilled: filled,
      liveOrdersCanceled: canceled,
      liveOrdersOpen: open,
      liveOrdersRejected: rejected,
      livePositionsTotal: posTotal,
      livePositionsOpen: posOpen,
      lastLiveOrderAt: lastFilledOrder?.at ?? null,
      lastFilledOrder,
    },
  };
}

// ── Laporan utama ─────────────────────────────────────────────────────────
/**
 * Entry terakhir per lane (bukti DB) — dipakai untuk menandai lane PAPER
 * "frozen" (tidak ada entry baru sejak go-live).
 */
async function lastEntryAtByPrefix(prefix: "LIVE_" | "PAPER_"): Promise<number | null> {
  try {
    const row = await db.position.findFirst({
      where: { source: { startsWith: prefix } },
      orderBy: { openedAt: "desc" },
      select: { openedAt: true },
    });
    return row?.openedAt?.getTime() ?? null;
  } catch {
    return null;
  }
}

async function computeReport(): Promise<LiveDashboardReport> {
  const [mirror, liveLane, paperLane, guard, workers, lastLiveEntry, lastPaperEntry, activity] = await Promise.all([
    getMirrorCached().catch((err) => {
      logger.warn({ err: (err as Error)?.message }, "LIVE_DASHBOARD_MIRROR_FAILED");
      return null;
    }),
    buildLiveLane().catch(() => null),
    buildPaperLane().catch(() => null),
    defaultDailyRiskGuard.evaluateStatus().catch(() => null),
    Promise.all(FORWARD_WORKERS.map(fetchForwardWorker)),
    lastEntryAtByPrefix("LIVE_"),
    lastEntryAtByPrefix("PAPER_"),
    buildLiveActivity().catch((err) => {
      logger.warn({ err: (err as Error)?.message }, "LIVE_DASHBOARD_ACTIVITY_FAILED");
      return null;
    }),
  ]);

  const emptyLane = (max: number): LaneStats => ({
    status: "UNAVAILABLE", error: "LANE_QUERY_FAILED",
    openPositions: 0, maxPositions: max, closedTrades: 0, winRatePct: null,
    netPnlUsd: 0, equityUsd: 0, unrealizedPnlUsd: 0,
    lastEntryAt: null, lastTradeAt: null, positions: [], trades: [],
    exchangeOnlyPositions: [],
  });

  const live: LaneStats = liveLane ?? emptyLane(Math.max(1, Number(env.LIVE_MAX_OPEN_POSITIONS ?? 1)));
  const paper: LaneStats = paperLane ?? emptyLane(20);

  // Posisi yang ada di exchange tapi belum ada di DB (mis. service restart
  // tepat setelah fill). Wajib terlihat: supervisor hanya memproses posisi
  // yang ADA di DB, jadi posisi seperti ini tidak terlacak exit/ledger.
  const dbLiveSymbols = new Set(live.positions.map((p) => p.symbol.toUpperCase()));
  live.exchangeOnlyPositions = detectExchangeOnlyPositions(mirror, dbLiveSymbols);

  // Mark price live untuk kedua lane (satu fetch, dipakai bersama).
  const symbols = [...live.positions, ...paper.positions].map((p) => p.symbol);
  const marks = new Map<string, number>();
  if (symbols.length > 0) {
    try {
      const { binanceFuturesClient } = await import("../markets/binanceFuturesClient.js");
      const { map } = binanceFuturesClient.getHubPrices(symbols);
      for (const sym of symbols) {
        const q = map[sym];
        if (q && Number.isFinite(q.m) && q.m > 0) marks.set(sym, Number(q.m));
      }
    } catch (err) {
      logger.warn({ err: (err as Error)?.message }, "LIVE_DASHBOARD_MARKS_UNAVAILABLE");
    }
  }
  attachUnrealized(live, marks);
  attachUnrealized(paper, marks);

  // Equity per lane: LIVE = saldo exchange (satu-satunya sumber kebenaran
  // riil); PAPER = modal simulasi + PnL lane PAPER sendiri.
  const exchangeBalance = mirror?.exchange.walletBalance ?? null;
  live.equityUsd = exchangeBalance ?? Number((live.netPnlUsd + live.unrealizedPnlUsd).toFixed(2));
  paper.equityUsd = Number((START_EQUITY_USD + paper.netPnlUsd + paper.unrealizedPnlUsd).toFixed(2));

  const workerOk = workers.filter((w) => w.status === "OK");
  const activePrefix: "PAPER" | "LIVE" = env.BINANCE_EXECUTION_MODE === "LIVE" ? "LIVE" : "PAPER";
  // Lane PAPER di DB utama frozen bila entry PAPER terakhir LEBIH LAMA dari
  // entry LIVE terakhir -> artinya sejak live mulai, tidak ada entry paper baru
  // (mode global menentukan prefix source saat entry).
  const paperDbLaneFrozen =
    activePrefix === "LIVE" &&
    lastPaperEntry != null &&
    (lastLiveEntry == null || lastPaperEntry < lastLiveEntry);
  const paperNote = paperDbLaneFrozen
    ? `Lane PAPER (DB utama) FROZEN: entry paper terakhir ${new Date(lastPaperEntry!).toISOString()}. `
      + `Entry baru masuk lane LIVE. Paper yang terus berjalan = forward-paper worker di bawah.`
    : `Entry baru masuk lane ${activePrefix}.`;

  return {
    generatedAt: new Date().toISOString(),
    executionMode: env.BINANCE_EXECUTION_MODE,
    armed: defaultDailyRiskGuard.isArmed(),
    canTrade: guard?.canTrade ?? false,
    guardReasons: guard?.reasons ?? [],
    exchangeBalanceUsd: exchangeBalance,
    exchangeAvailableUsd: mirror?.exchange.availableBalance ?? null,
    exchangeStatus: mirror?.exchange.status ?? "UNAVAILABLE",
    exchangeError: mirror?.exchange.error,
    entryActivity: {
      activePrefix,
      activeDbLane: activePrefix === "LIVE" ? "live" : "paper",
      paperDbLaneFrozen,
      note: paperNote,
    },
    live,
    paper,
    forwardPaper: {
      status: workerOk.length > 0 ? "OK" : "UNAVAILABLE",
      error: workerOk.length > 0 ? undefined : "NO_FORWARD_WORKER_AVAILABLE",
      workers,
    },
    activity: activity ?? {
      status: "UNAVAILABLE",
      error: "ACTIVITY_UNAVAILABLE",
      orders: [],
      positions: [],
      events: [],
      summary: {
        liveOrdersTotal: 0, liveOrdersFilled: 0, liveOrdersCanceled: 0,
        liveOrdersOpen: 0, liveOrdersRejected: 0,
        livePositionsTotal: 0, livePositionsOpen: 0, lastLiveOrderAt: null,
        lastFilledOrder: null,
      },
    },
    mirror: mirror ?? {
      generatedAt: new Date().toISOString(),
      exchange: {
        status: "UNAVAILABLE", error: "MIRROR_UNAVAILABLE",
        walletBalance: null, availableBalance: null, positions: [], openOrders: [], openAlgoOrders: [],
      },
      db: {
        positions: [], orders: [], equityUsd: 0,
        executionMode: env.BINANCE_EXECUTION_MODE, armed: defaultDailyRiskGuard.isArmed(),
      },
      positions: [],
      orders: [],
    },
  };
}

/**
 * Entry point publik. TIDAK meng-cache report utuh: hanya panggilan SIGNED
 * ke exchange yang di-cache (getMirrorCached). Data activity diambil dari DB
 * setiap request supaya alert order live baru muncul segera.
 */
export async function buildLiveDashboardReport(): Promise<LiveDashboardReport> {
  return computeReport();
}
