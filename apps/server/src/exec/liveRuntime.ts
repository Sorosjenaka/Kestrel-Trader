// apps/server/src/exec/liveRuntime.ts — Jalur LIVE minimal (keputusan operator 10 Okt 2026).
// Keputusan operator yang dikunci di sini:
//   - Risk per trade LIVE = $1 (tetap); fee TIDAK dimodel di bot (Binance yang memotong).
//   - Fase test $3: LIVE_MAX_OPEN_POSITIONS=1; fase $30 nanti: 3 + daily DD cap $7.
//   - SL/TP WAJIB terpasang di exchange SEBELUM entry dianggap sukses (safety-first).
// Arsitektur:
//   - liveExchange        = BinanceUsdMClient asli (LIVE) / undefined (PAPER).
//   - liveOrderExecutor   = OrderExecutor menempel liveExchange (idempoten,
//                           persist-before-send, verifyFill bawaan orderExecutor).
//   - prepareLiveSymbol() = PRE-ENTRY: set leverage + margin + cek flat (wajib flat).
//   - checkLiveEntryGate()= PRE-ENTRY: balance/margin/min-notional (fail-closed).
//   - attachLiveSafety()  = POST-FILL: SL algo close-all + TP LIMIT reduceOnly.
//                           GAGAL pasang = posisi langsung ditutup market (fail-closed).
//   - livePositionWatcher = timer 3 dtk: posisi exchange flat tapi DB masih OPEN
//                           → tutup di DB (SL/TP exchange yang menutup, akuntansi gross).
//   - exchangeReconcileSource = adapter reconciler boot (mode-independent sejak G4
//     25 Okt 2026; GET signed saja; undefined hanya bila API key tidak ada).
//   - liveEmergencyFlatten()  = kill switch LIVE: cancel semua algo + flat market.
// PAPER: seluruh export di bawah no-op / fallback paper, jadi mengimpor modul ini
// tidak pernah mengaktifkan OrderExecutor exchange di mode PAPER.
import { BinanceUsdMClient } from "./binanceUsdMClient.js";
import { FuturesOrderManager } from "./futuresOrderManager.js";
import { OrderExecutor, defaultOrderExecutor, prismaOrderExecRepo } from "./orderExecutor.js";
import { env } from "../core/env.js";
import { db } from "../core/db.js";
import { logger } from "../core/logger.js";
import { defaultDailyRiskGuard } from "../risk/dailyGuard.js";
import { lossCooldownGuard } from "../risk/lossCooldown.js";
import { updateClosedDirectionBattle } from "../learning/directionBattleLearning.js";
import { roundToTick } from "../risk/riskEngine.js";
import { aggregateExitFills, decideExitAccounting, fetchUserTradesWindow, type AggregatedExit } from "./exitAccounting.js";
import { netRealizedPnlUsd, estimateFillFeeUsd } from "../config/costs.js";
import { cleanupProtectiveOrders, cancelWithConfirmation } from "./bracketCleanup.js";
import { bracketAlgoIds } from "./preEntryBracket.js";
import { bracketAlgoIdsV2 } from "./preEntryBracket.js";
import { parseAlgoFillEvidence, planLiveLadder } from "./liveLadder.js";
import { withTimeout } from "./inFlightCache.js";
import { cachedPositionRiskAll } from "./signedSnapshotCache.js";
import { usesSwingRr23 } from "../strategies/swing/researchExitPolicy.js";
import type { PositionRow } from "./positionSupervisor.js";
import { binanceFuturesClient } from "../markets/binanceFuturesClient.js";

export const LIVE_MODE = env.BINANCE_EXECUTION_MODE === "LIVE";

// ── T-01: executor exchange ────────────────────────────────────────────────
// Kunci hanya dibaca dari env saat startup; tidak pernah di-log.
export const liveExchange: BinanceUsdMClient | undefined =
  LIVE_MODE && env.BINANCE_API_KEY && env.BINANCE_API_SECRET
    ? new BinanceUsdMClient({ apiKey: env.BINANCE_API_KEY, apiSecret: env.BINANCE_API_SECRET })
    : undefined;

export const liveOrderExecutor: OrderExecutor = LIVE_MODE && liveExchange
  ? new OrderExecutor({
      exchange: liveExchange,
      paperAllowed: false,
      isArmed: () => defaultDailyRiskGuard.isArmed(),
      repo: prismaOrderExecRepo,
    })
  : defaultOrderExecutor;

/** Executor yang benar untuk mode aktif (dipakai jalur entry & exit). */
export const activeOrderExecutor: OrderExecutor = LIVE_MODE ? liveOrderExecutor : defaultOrderExecutor;

// ── T-03: pre-entry checks ─────────────────────────────────────────────────
export interface LiveEntryGateResult { allowed: boolean; reason?: string }

/** Snapshot available balance USDT dari exchange (fail-closed: error = null). */
export async function fetchLiveBalanceUsd(): Promise<number | null> {
  if (!liveExchange) return null;
  try {
    const balances = await liveExchange.getBalances();
    const usdt = balances.find((b) => b.asset === "USDT");
    const available = Number(usdt?.availableBalance ?? usdt?.balance ?? NaN);
    return Number.isFinite(available) && available >= 0 ? available : null;
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, "LIVE_BALANCE_FETCH_FAILED");
    return null;
  }
}

/** Gate sebelum order LIVE dikirim. Gagal mengambil data = TOLAK (fail-closed). */
export async function checkLiveEntryGate(input: {
  symbol: string; notionalUsd: number; leverage: number;
}): Promise<LiveEntryGateResult> {
  if (!LIVE_MODE) return { allowed: true };
  // 11 Okt 2026 (GO LIVE): batas posisi LIVE dihitung dari posisi LIVE saja. Posisi PAPER
  // peninggalan periode simulasi TIDAK memakan slot (mereka ditutup sendiri oleh supervisor
  // lewat SL/TP virtual mereka) dan tidak memblokir entry LIVE.
  const openLive = await db.position.count({ where: { status: "OPEN", source: { startsWith: "LIVE_" } } });
  if (openLive >= env.LIVE_MAX_OPEN_POSITIONS) {
    return { allowed: false, reason: `LIVE_MAX_POSITIONS_${openLive}/${env.LIVE_MAX_OPEN_POSITIONS}` };
  }
  const balance = await fetchLiveBalanceUsd();
  if (balance === null) return { allowed: false, reason: "LIVE_BALANCE_UNAVAILABLE" };
  if (balance < env.LIVE_MIN_BALANCE_USD) {
    return { allowed: false, reason: `LIVE_BALANCE_BELOW_MIN_${balance.toFixed(2)}<${env.LIVE_MIN_BALANCE_USD}` };
  }
  const marginNeeded = input.leverage > 0 ? input.notionalUsd / input.leverage : input.notionalUsd;
  // 11 Okt 2026 — perintah operator: "scalp margin buat maksimal 3$ di live futures".
  const marginCap = env.LIVE_MAX_MARGIN_USD;
  if (!(marginCap > 0) || marginNeeded > marginCap + 1e-9) {
    return { allowed: false, reason: `LIVE_MARGIN_CAP_${marginNeeded.toFixed(2)}>${marginCap.toFixed(2)}` };
  }
  // Buffer = cadangan fee + funding (0.25% notional, minimum $0.10). Menggantikan buffer
  // 2x-risk lama (marginNeeded + 2*RISK) yang menolak SEMUA entry pada balance $3.31 —
  // butuh $4+, padahal margin maks $3 (audit 11 Okt 2026). Risiko loss sendiri sudah
  // ditutup SL di exchange (maks $1.2 per trade, perintah operator 11 Okt 2026).
  const feeReserve = Math.max(0.1, input.notionalUsd * 0.0025);
  const required = marginNeeded + feeReserve;
  if (balance < required) {
    return { allowed: false, reason: `LIVE_MARGIN_INSUFFICIENT_need${required.toFixed(2)}_have${balance.toFixed(2)}` };
  }
  const sym = await db.symbol.findUnique({ where: { symbol: input.symbol } });
  const minNotional = sym?.minNotional ?? 5;
  if (input.notionalUsd < minNotional) {
    return { allowed: false, reason: `NOTIONAL_LT_MIN_${input.notionalUsd.toFixed(2)}<${minNotional}` };
  }
  return { allowed: true };
}

// ── T-02a: PRE-ENTRY symbol prep (leverage + margin + cek flat) ────────────
export async function prepareLiveSymbol(input: {
  symbol: string; leverage: number; marginMode: "CROSS" | "ISOLATED";
}): Promise<{ ok: boolean; reason?: string }> {
  if (!LIVE_MODE || !liveExchange) return { ok: true }; // PAPER: tidak perlu.
  const manager = new FuturesOrderManager(liveExchange);
  try {
    await manager.prepareSymbol(input.symbol, input.leverage, input.marginMode);
    return { ok: true };
  } catch (err) {
    const reason = `PREPARE_SYMBOL_FAILED_${(err as Error).message}`;
    logger.warn({ symbol: input.symbol, reason }, "LIVE_PREPARE_SYMBOL_REJECTED");
    return { ok: false, reason };
  }
}

// ── T-02b: POST-FILL orkestrasi SL → TP (safety-first) ─────────────────────
export interface LiveSafetyResult { ok: boolean; reason?: string; slClientAlgoId?: string; tpClientOrderId?: string }

/**
 * Pasang SL (algo close-all stop) + TP (LIMIT reduceOnly) segera setelah entry
 * MARKET fill. KEGAGALAN salah satu = posisi LANGSUNG ditutup market (fail-closed).
 * tp1Price=null → TP tidak dipasang; SL tetap wajib.
 */
export async function attachLiveSafety(input: {
  positionId: number; symbol: string; side: "LONG" | "SHORT";
  entryPrice: number; qty: number; slPrice: number; tp1Price: number | null;
  entryClientOrderId: string; tickSize: number;
}): Promise<LiveSafetyResult> {
  if (!LIVE_MODE || !liveExchange) return { ok: true }; // PAPER: supervisor internal.
  const manager = new FuturesOrderManager(liveExchange);
  let slClientAlgoId: string;
  try {
    const stop = await manager.ensureCloseAllStop({
      entryClientOrderId: input.entryClientOrderId,
      symbol: input.symbol,
      positionSide: input.side,
      entryPrice: input.entryPrice,
      triggerPrice: input.slPrice,
      filledQty: input.qty,
    });
    slClientAlgoId = stop.clientAlgoId;
    livePositionWatcher.recordStopIntent(input.positionId, slClientAlgoId);
    logger.info({ positionId: input.positionId, symbol: input.symbol, slTrigger: stop.triggerPrice, algoId: stop.algoId }, "LIVE_SL_PLACED");
  } catch (err) {
    return abortLiveEntry(input, `SL_PLACEMENT_FAILED_${(err as Error).message}`);
  }
  let tpClientOrderId: string | undefined;
  if (input.tp1Price && input.tp1Price > 0) {
    const tpPrice = roundToTick(input.tp1Price, input.tickSize);
    tpClientOrderId = `TP_${input.entryClientOrderId}`.slice(0, 36);
    try {
      const res = await liveOrderExecutor.executeOrder({
        clientOrderId: tpClientOrderId,
        symbol: input.symbol,
        side: input.side === "LONG" ? "SELL" : "BUY",
        type: "LIMIT",
        price: tpPrice,
        qty: input.qty,
        reduceOnly: true,
        positionId: input.positionId,
      });
      if (!["NEW", "PARTIAL", "FILLED"].includes(res.status)) {
        const rechecked = await db.orderExec.findUnique({ where: { clientOrderId: tpClientOrderId } });
        if (!rechecked || !["NEW", "PARTIAL", "FILLED"].includes(rechecked.status)) {
          throw new Error(`TP_STATUS_${rechecked?.status ?? res.status ?? "UNKNOWN"}`);
        }
      }
      logger.info({ positionId: input.positionId, symbol: input.symbol, tpPrice, status: res.status }, "LIVE_TP_PLACED");
    } catch (err) {
      return abortLiveEntry(input, `TP_PLACEMENT_FAILED_${(err as Error).message}`, slClientAlgoId);
    }
  }
  await db.eventLog.create({
    data: {
      type: "LIVE_SAFETY_ATTACHED",
      severity: "info",
      payload: JSON.stringify({ positionId: input.positionId, symbol: input.symbol, side: input.side, slClientAlgoId, tpClientOrderId }),
    },
  });
  return { ok: true, slClientAlgoId, tpClientOrderId };
}

async function abortLiveEntry(input: {
  positionId: number; symbol: string; side: "LONG" | "SHORT"; qty: number;
  entryPrice: number; entryClientOrderId: string;
}, reason: string, _slClientAlgoId?: string): Promise<LiveSafetyResult> {
  logger.error({ positionId: input.positionId, symbol: input.symbol, reason }, "LIVE_SAFETY_FAILED_CLOSING_POSITION");
  // Tutup posisi apa adanya di pasar (reduceOnly) — fail-closed. Harga hanya
  // untuk lolos validasi executor; MARKET tidak memakai price.
  try {
    const closeId = `ABORT_${input.entryClientOrderId}`.slice(0, 36);
    await liveOrderExecutor!.executeOrder({
      clientOrderId: closeId,
      symbol: input.symbol,
      side: input.side === "LONG" ? "SELL" : "BUY",
      type: "MARKET",
      price: input.entryPrice,
      qty: input.qty,
      reduceOnly: true,
      positionId: input.positionId,
    });
  } catch (closeErr) {
    logger.error({ positionId: input.positionId, symbol: input.symbol, err: (closeErr as Error).message }, "LIVE_ABORT_CLOSE_FAILED_ORPHAN_RISK");
    await db.eventLog.create({
      data: {
        type: "LIVE_ABORT_CLOSE_FAILED",
        severity: "error",
        payload: JSON.stringify({ positionId: input.positionId, symbol: input.symbol, reason, error: (closeErr as Error).message }),
      },
    });
  }
  // Baris DB TIDAK ditutup manual: livePositionWatcher akan mendeteksi posisi
  // exchange flat dan mencatat PnL riil (atau reconciler menangkap orphan bila
  // close market gagal). Menjaga akuntansi jujur.
  return { ok: false, reason };
}

// ── T-02c: watcher posisi LIVE (SL/TP di exchange yang menutup) ────────────
/** TAHAP 1C (26 Okt 2026): catat leg ladder LIVE dari bukti fill AKTUAL exchange
 * ke ledger exitAccounting posisi. Idempoten per clientAlgoId: leg yang sudah
 * tercatat dengan qty >= bukti baru tidak ditulis ulang (event duplikat/terlambat
 * aman); qty kumulatif yang bertambah diperbarui tanpa double-count. Fee =
 * estimasi maker (TP LIMIT) yang jujur (feeEstimated tetap true sampai
 * rekonsiliasi userTrades). Tidak pernah mengarang harga: caller WAJIB memberi
 * bukti actualPrice dari exchange. */
export async function recordLiveLadderLeg(input: {
  pos: PositionRow;
  phase: "TP1" | "TP2";
  clientAlgoId: string;
  childOrderId: string | null;
  qty: number;
  price: number;
}): Promise<{ realizedNetUsd: number; remainingQty: number } | null> {
  const { pos, phase, clientAlgoId, qty, price } = input;
  if (!(qty > 0) || !(price > 0)) return null;
  let ledger: { orders?: Record<string, Record<string, unknown>>; legacyQty?: number; legacyRealized?: number } = { orders: {} };
  try { ledger = pos.exitAccounting ? JSON.parse(pos.exitAccounting) : ledger; } catch { /* ledger rusak -> mulai baru */ }
  if (!ledger.orders || typeof ledger.orders !== "object") ledger.orders = {};
  const existing = ledger.orders[clientAlgoId] as { qty?: number } | undefined;
  if (existing && Number(existing.qty ?? 0) >= qty - 1e-12) return null; // duplikat / tak berubah
  const fee = estimateFillFeeUsd({ qty, price, isMaker: true });
  ledger.orders[clientAlgoId] = {
    phase, requestedQty: qty, qty, notional: qty * price, fee, status: "FILLED",
    simulated: false, estimated: true, fillPrice: price,
    childOrderId: input.childOrderId, evidence: "ALGO_ACTUAL_PRICE",
  };
  const legs = Object.values(ledger.orders) as Array<{ qty?: number; notional?: number; fee?: number }>;
  const originalQty = pos.originalQty ?? pos.qty;
  const legsQty = legs.reduce((n, l) => n + Number(l.qty ?? 0), 0);
  const exitedQty = (ledger.legacyQty ?? 0) + legsQty;
  const exitNotional = legs.reduce((n, l) => n + Number(l.notional ?? 0), 0);
  const exitFees = legs.reduce((n, l) => n + Number(l.fee ?? 0), 0);
  const directional = pos.side === "LONG" ? 1 : -1;
  const gross = (ledger.legacyRealized ?? 0) + directional * (exitNotional - pos.entryPrice * legsQty);
  const entryFeeRaw = Number(pos.entryFeeUsd ?? 0);
  const entryFee = Number.isFinite(entryFeeRaw) && entryFeeRaw > 0 ? entryFeeRaw : 0;
  const entryFeeShare = originalQty > 0 ? entryFee * Math.min(1, exitedQty / originalQty) : entryFee;
  const net = netRealizedPnlUsd(gross, entryFeeShare + exitFees, 0);
  const remainingQty = Math.max(0, Number((originalQty - exitedQty).toFixed(12)));
  await db.position.update({
    where: { id: pos.id },
    data: { exitAccounting: JSON.stringify(ledger), realizedPnlUsd: net },
  }).catch(() => undefined);
  return { realizedNetUsd: net, remainingQty };
}

// 30 Okt 2026 (Tahap 0+1 rencana docs/plan-fix-watcher-2026-10-30.md):
// instrumentasi jalur watcher (masuk/skip/alasan skip/error/hasil) supaya
// insiden "senyap" seperti #3239/#3240 tidak lagi tanpa jejak, plus
// anti-menggantung pola withTimeout (inFlightCache.ts, fix mirrorInFlight
// f918498): satu tick WAJIB settle — yang menggantung dihentikan paksa dan
// `running` dilepas, bukan meracuni semua tick sesudahnya selamanya.
const WATCHER_TICK_TIMEOUT_MS = 60_000;
const WATCHER_LOG_THROTTLE_MS = 60_000;

export class LivePositionWatcher {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private slAlgoByPosition = new Map<number, string>();
  private accountingDeferredAt = new Map<number, number>();
  private entryAgeEventKeys = new Set<string>();
  // 30 Okt 2026 — Tahap 0+1: state watchdog + dedup log.
  private runSeq = 0;
  private runningSinceMs = 0;
  private readonly tickTimeoutMs: number;
  private lastSkipReason: string | null = null;
  private lastSkipLoggedAt = 0;
  private lastHeartbeatAt = 0;
  private flatAnnounced = new Set<number>();
  // 28 Okt 2026 (audit "market tidak terbaca"): 429/-1003 dari IP shared
  // berarti Binance meminta kita BERHENTI. Dulu watcher tetap mengetuk tiap
  // 3 dtk saat kena limit (5x LIVE_WATCHER_TICK_FAILED/5 mnt -> eskalasi 418
  // yang memblokir depth/market juga). Kini satu teguran = jeda eksponensial
  // 30 dtk..5 mnt; tick yang lengkap sukses mengulang nol.
  private rateLimitBackoffMs = 0;
  private rateLimitUntil = 0;
  // A4 (30 Okt 2026): snapshot positionRisk dibagi dengan mirror/monitor via
  // signedSnapshotCache (TTL default 3 dtk). snapshotTtlMs <= 0 = tanpa cache.
  private readonly snapshotTtlMs: number;

  constructor(opts?: { tickTimeoutMs?: number; snapshotTtlMs?: number }) {
    this.tickTimeoutMs = opts?.tickTimeoutMs ?? WATCHER_TICK_TIMEOUT_MS;
    this.snapshotTtlMs = opts?.snapshotTtlMs ?? 3_000;
  }

  private onTickError(err: unknown): void {
    const msg = (err as Error)?.message ?? String(err);
    const status = (err as { httpStatus?: number } | null)?.httpStatus;
    if (status === 429 || status === 418 || /code -1003/.test(msg)) {
      this.rateLimitBackoffMs = Math.min(this.rateLimitBackoffMs ? this.rateLimitBackoffMs * 2 : 30_000, 300_000);
      this.rateLimitUntil = Date.now() + this.rateLimitBackoffMs;
      logger.warn({ err: msg, backoffMs: this.rateLimitBackoffMs }, "LIVE_WATCHER_RATE_LIMIT_BACKOFF");
      return;
    }
    logger.warn({ err: msg }, "LIVE_WATCHER_TICK_FAILED");
  }

  recordStopIntent(positionId: number, slClientAlgoId: string): void {
    this.slAlgoByPosition.set(positionId, slClientAlgoId);
  }

  start(): void {
    if (!LIVE_MODE || this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch((err) => this.onTickError(err)); }, 3000);
    logger.info("LivePositionWatcher aktif (mode LIVE)");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (!liveExchange) { this.logSkip("NO_LIVE_EXCHANGE"); return; }
    const now = Date.now();
    if (this.running) {
      // Watchdog defensif (pola racun mirrorInFlight): `running` yang tidak
      // pernah dilepas = tick sebelumnya menggantung dan semua tick sesudahnya
      // diam-diam no-op — inilah pola "senyap" insiden #3239/#3240. Dengan
      // withTimeout di bawah ini seharusnya mustahil terjadi; kalau tetap
      // terdeteksi, bebaskan + alarm, jangan diam.
      if (now - this.runningSinceMs < this.tickTimeoutMs * 2) return;
      const hungForMs = now - this.runningSinceMs;
      logger.warn({ hungForMs }, "LIVE_WATCHER_TICK_HUNG");
      void db.eventLog.create({ data: { type: "LIVE_WATCHER_TICK_HUNG", severity: "warn",
        payload: JSON.stringify({ hungForMs, source: "RUNNING_FLAG_WATCHDOG" }) } }).catch(() => undefined);
      this.runSeq += 1; // invalidasi run lama agar finally-nya tidak mengganggu run baru
      this.running = false;
    }
    // Hormati jeda rate-limit: jangan kirim satu pun request signed selama
    // jeda berjalan (SL/TP tetap resting di exchange, proteksi tidak hilang).
    if (now < this.rateLimitUntil) {
      this.logSkip("RATE_LIMIT_BACKOFF_ACTIVE", { backoffMs: this.rateLimitBackoffMs });
      return;
    }
    const run = ++this.runSeq;
    this.running = true;
    this.runningSinceMs = Date.now();
    try {
      await withTimeout(this.tickBody(), this.tickTimeoutMs, "LivePositionWatcher.tick");
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      if (msg.includes("LivePositionWatcher.tick: timeout")) {
        // 30 Okt 2026 (Tahap 1): tick dihentikan paksa karena menggantung.
        // `running` dilepas oleh finally di bawah -> tick berikutnya jalan lagi
        // dengan koneksi segar (self-healing, pola fix mirrorInFlight f918498).
        // Dilaporkan terpisah dari tick gagal biasa, dan TIDAK mengubah
        // klasifikasi rate-limit (bukan 429/418).
        logger.warn({ err: msg, timeoutMs: this.tickTimeoutMs }, "LIVE_WATCHER_TICK_HUNG");
        void db.eventLog.create({ data: { type: "LIVE_WATCHER_TICK_HUNG", severity: "warn",
          payload: JSON.stringify({ err: msg, timeoutMs: this.tickTimeoutMs, source: "TICK_TIMEOUT" }) } }).catch(() => undefined);
        return;
      }
      throw err; // perilaku lama: diklasifikasikan onTickError di caller (start)
    } finally {
      // Hanya run terbaru yang boleh melepas flag; run lama yang sempat
      // menggantung tidak boleh mengganggu run yang sedang berjalan.
      if (this.runSeq === run) {
        this.running = false;
        this.runningSinceMs = 0;
      }
    }
  }

  /** Isi satu tick (dibungkus withTimeout oleh tick(); lihat Tahap 1). */
  private async tickBody(): Promise<void> {
    const startedAt = Date.now();
    const openPositions = await db.position.findMany({
      where: { status: "OPEN", source: { startsWith: "LIVE_" } },
    });
    if (openPositions.length === 0) {
      this.logSkip("NO_OPEN_LIVE_POSITIONS");
      return;
    }
    // Update mfe/mae dari price hub agar excursions terekam walau exit di exchange.
    const hub = binanceFuturesClient.getHubPrices();
    for (const pos of openPositions) {
      const mark = Number(hub.map[pos.symbol]?.m ?? 0);
      if (!(mark > 0)) continue;
      const long = pos.side === "LONG";
      const mfe = long ? Math.max(pos.mfePrice ?? pos.entryPrice, mark) : Math.min(pos.mfePrice ?? pos.entryPrice, mark);
      const mae = long ? Math.min(pos.maePrice ?? pos.entryPrice, mark) : Math.max(pos.maePrice ?? pos.entryPrice, mark);
      if (mfe !== pos.mfePrice || mae !== pos.maePrice) {
        await db.position.update({ where: { id: pos.id }, data: { mfePrice: mfe, maePrice: mae } }).catch(() => undefined);
        pos.mfePrice = mfe; pos.maePrice = mae;
      }
    }
    // Satu panggilan posisi exchange (tanpa symbol = semua). A4: lewat cache
    // snapshot pendek — watcher/mirror/monitor berbagi satu panggilan per
    // jendela TTL; gagal/timeout TIDAK di-cache (self-healing, pola
    // inFlightCache). Kesegaran <= 3 dtk hanya memengaruhi akuntansi (deteksi
    // flat), bukan entry/sizing/risk/eksekusi.
    const exchangePositions = await cachedPositionRiskAll(liveExchange!, { ttlMs: this.snapshotTtlMs });
    this.rateLimitBackoffMs = 0; // signed call sukses -> jeda rate-limit diulang nol
    const flatSymbols = new Set(
      exchangePositions
        .filter((p) => Number.isFinite(Number(p.positionAmt)) && Number(p.positionAmt) === 0)
        .map((p) => p.symbol)
    );
    let finalized = 0;
    let deferred = 0;
    let advanced = 0;
    let staleSkipped = 0;
    for (const pos of openPositions) {
      if (!flatSymbols.has(pos.symbol)) { await this.advanceLadder(pos); advanced += 1; continue; }
      // Tahap 0: deteksi flat = momen kritis (dulu tidak terlihat sama sekali).
      if (!this.flatAnnounced.has(pos.id)) {
        this.flatAnnounced.add(pos.id);
        logger.info({ positionId: pos.id, symbol: pos.symbol }, "LIVE_WATCHER_POS_FLAT_DETECTED");
      }
      const fresh = await db.position.findUnique({ where: { id: pos.id } });
      if (!fresh || fresh.status !== "OPEN") {
        // Alasan skip eksplisit: baris sudah berubah sejak findMany (mis. sudah
        // difinalisasi jalur lain) — bukan diam-diam.
        staleSkipped += 1;
        logger.info({ positionId: pos.id, symbol: pos.symbol, reason: !fresh ? "ROW_MISSING" : `STATUS_${fresh.status}` }, "LIVE_WATCHER_POS_SKIP");
        continue;
      }
      const outcome = await this.finalizeClosedPosition(fresh as PositionRow, Number(hub.map[pos.symbol]?.m ?? 0));
      if (outcome === "CLOSED") finalized += 1; else deferred += 1;
    }
    this.logHeartbeat({
      openCount: openPositions.length, flatMatched: finalized + deferred,
      finalized, deferred, advanced, staleSkipped,
      tickMs: Date.now() - startedAt, backoffMs: this.rateLimitBackoffMs,
    });
  }

  /** Log skip dengan dedup: alasan yang sama diulang maksimal 1x/menit. */
  private logSkip(reason: string, extra?: Record<string, unknown>): void {
    const now = Date.now();
    if (reason === this.lastSkipReason && now - this.lastSkipLoggedAt < WATCHER_LOG_THROTTLE_MS) return;
    this.lastSkipReason = reason;
    this.lastSkipLoggedAt = now;
    logger.info({ reason, ...extra }, "LIVE_WATCHER_SKIP");
  }

  /** Heartbeat tick (maks 1x/menit) — bukti watcher hidup + ringkasan hasil. */
  private logHeartbeat(payload: Record<string, unknown>): void {
    const now = Date.now();
    if (now - this.lastHeartbeatAt < WATCHER_LOG_THROTTLE_MS) return;
    this.lastHeartbeatAt = now;
    logger.info(payload, "LIVE_WATCHER_TICK");
  }

  /**
   * Port ladder TP SWING paper -> LIVE (19 Okt 2026, permintaan operator
   * "engine paper ke engine Live", ARM live TETAP OFF).
   * RR23: TP1 50% @2R dan TP2/final 50% @3R sudah resting dari pre-entry
   * bracket. Setelah TP1 FILLED, SL digeser ke BE; TP2 menutup sisa qty.
   * Legacy: TP1 40% + TP2 30% + TPMAX runner 30%. Idempoten via timestamp.
   */
  private async advanceLadder(pos: PositionRow): Promise<void> {
    if (!liveExchange || pos.mode !== "SWING" || pos.tp2Price == null || !(pos.tp2Price > 0)) return;
    if (pos.source && !String(pos.source).startsWith("LIVE_")) return;
    const entry = await bracketCleanupRepo.findEntryByPositionId(pos.id).catch(() => null);
    if (!entry || entry.reduceOnly || entry.clientOrderId.startsWith("SIM_")) return;
    const ids = bracketAlgoIdsV2(entry.clientOrderId);
    const rr23 = usesSwingRr23(pos);
    const plan = planLiveLadder({
      qty: pos.originalQty ?? pos.qty,
      stepSize: pos.quantityStep ?? 0,
      entryPrice: pos.entryPrice,
      tp1Price: pos.tp1Price,
      side: pos.side as "LONG" | "SHORT",
      swingExitPolicy: rr23 ? "RR23" : "LEGACY_40_30",
    });
    // 26 Okt 2026 (TAHAP 1A): bukti fill TP1 dari actualPrice/actualQty exchange,
    // BUKAN status algo. TRIGGERED hanya berarti harga menyentuh level dan child
    // order dikirim ke book — bukan bukti quantity terisi (TAKE_PROFIT LIMIT bisa
    // resting/partial setelah trigger).
    const tp1 = await liveExchange.queryAlgo(ids.tpClientAlgoId).catch(() => null);
    const tp1Ev = parseAlgoFillEvidence(tp1);
    const tp1FilledQty = tp1Ev.fillQty ?? 0;
    const step = pos.quantityStep && pos.quantityStep > 0 ? pos.quantityStep : 1e-8;
    const tp1TargetQty = plan?.tp1Qty ?? 0;
    // Fase TP1 penuh hanya bila qty terisi kumulatif >= target (toleransi 1/2 step).
    const tp1PhaseComplete = tp1TargetQty > 0 && tp1FilledQty >= tp1TargetQty - step * 0.5;
    if (rr23) {
      // RR23 has no runner. Move the exchange stop to BE only after the TP1
      // phase is CONFIRMED fully filled (actual qty >= target); TP2 is the
      // final 3R leg and closes the remainder. A TRIGGERED algo or a price
      // touch alone never completes the milestone.
      if (pos.tp1FilledAt == null && tp1Ev.confirmedFilled && tp1PhaseComplete) {
        const filledAt = new Date();
        const tp1FillPrice = tp1Ev.fillPrice ?? pos.tp1Price ?? null;
        // TAHAP 1C: sisa qty dari bukti fill AKTUAL exchange (actualQty), BUKAN
        // asumsi "pasti tinggal setengah". actualQty tak tersedia -> fallback plan.
        const originalQty = pos.originalQty ?? pos.qty;
        const remainingQty = tp1FilledQty > 0
          ? Math.max(0, Number((originalQty - tp1FilledQty).toFixed(12)))
          : (plan?.tp2Qty ?? pos.qty);
        // Catat leg TP1 ke ledger exit (idempoten, harga aktual exchange).
        if (tp1FillPrice != null && tp1FilledQty > 0) {
          await recordLiveLadderLeg({
            pos, phase: "TP1", clientAlgoId: ids.tpClientAlgoId,
            childOrderId: tp1Ev.childOrderId, qty: tp1FilledQty, price: tp1FillPrice,
          }).catch(() => undefined);
        }
        await db.position.update({ where: { id: pos.id }, data: {
          tp1FilledAt: filledAt,
          // Harga fill aktual dari exchange; fallback level TP1 hanya bila
          // exchange tidak memberi actualPrice (tidak pernah mengarang).
          tp1FillPrice: tp1FillPrice ?? undefined,
          // TP1 filled 50%: the live stop replacement must cover only the
          // remaining TP2/final leg, never the already-closed half.
          qty: remainingQty,
          notional: remainingQty * pos.entryPrice,
          marginUsd: (remainingQty * pos.entryPrice) / Math.max(1, pos.leverage ?? 1),
        } }).catch(() => undefined);
        pos = { ...pos, tp1FilledAt: filledAt, qty: remainingQty } as PositionRow;
      } else if (pos.tp1FilledAt == null && tp1FilledQty > 0) {
        // TP1 terisi bertahap (partial) — catat progres tanpa menyelesaikan
        // fase dan tanpa memindah BE; akuntansi final dari fill asli di watcher.
        // Ledger exit: akumulasi bertahap idempoten (qty tak bertambah = no-op).
        if (tp1Ev.fillPrice != null) {
          await recordLiveLadderLeg({
            pos, phase: "TP1", clientAlgoId: ids.tpClientAlgoId,
            childOrderId: tp1Ev.childOrderId, qty: tp1FilledQty, price: tp1Ev.fillPrice,
          }).catch(() => undefined);
        }
        await db.eventLog.create({ data: { type: "LADDER_TP1_PARTIAL_FILL", severity: "info",
          payload: JSON.stringify({ positionId: pos.id, symbol: pos.symbol,
            filledQty: tp1FilledQty, targetQty: tp1TargetQty,
            fillPrice: tp1Ev.fillPrice, triggered: tp1Ev.triggered,
            childOrderId: tp1Ev.childOrderId }) } }).catch(() => undefined);
      }
      // Restart-safe: if TP1 was already recorded before this process, the
      // live stop must still cover only the remaining TP2/final quantity.
      if (pos.tp1FilledAt != null && plan && pos.qty > plan.tp2Qty + 1e-12) {
        // TAHAP 1C: ledger exit (fill aktual) lebih benar daripada asumsi plan;
        // fallback plan hanya bila ledger tidak terbaca.
        let remainingQty = plan.tp2Qty;
        try {
          const ledger = pos.exitAccounting ? JSON.parse(pos.exitAccounting) : null;
          const legsQty = Object.values((ledger?.orders ?? {}) as Record<string, { qty?: number }>)
            .reduce((n, l) => n + Number(l?.qty ?? 0), 0);
          const orig = pos.originalQty ?? pos.qty;
          if (legsQty > 0) remainingQty = Math.max(0, Number((orig - legsQty).toFixed(12)));
        } catch { /* ledger tak terbaca -> plan */ }
        await db.position.update({ where: { id: pos.id }, data: {
          qty: remainingQty,
          notional: remainingQty * pos.entryPrice,
          marginUsd: (remainingQty * pos.entryPrice) / Math.max(1, pos.leverage ?? 1),
        } }).catch(() => undefined);
        pos = { ...pos, qty: remainingQty } as PositionRow;
      }
      if (pos.tp1FilledAt != null && plan && pos.slPrice !== pos.entryPrice) {
        try {
          await moveSlToBeLive(pos);
          await db.position.update({ where: { id: pos.id }, data: { slPrice: pos.entryPrice } });
          pos = { ...pos, slPrice: pos.entryPrice } as PositionRow;
        } catch (err) {
          logger.warn({ positionId: pos.id, symbol: pos.symbol, err: (err as Error)?.message }, "LADDER_RR23_BE_MOVE_FAILED");
        }
      }
      const tp2 = await liveExchange.queryAlgo(ids.tp2ClientAlgoId).catch(() => null);
      const tp2Ev = parseAlgoFillEvidence(tp2);
      if (tp2Ev.confirmedFilled && pos.tp2FilledAt == null) {
        // TAHAP 1C: catat leg final TP2 dari bukti fill aktual (idempoten).
        if (tp2Ev.fillPrice != null && (tp2Ev.fillQty ?? 0) > 0) {
          await recordLiveLadderLeg({
            pos, phase: "TP2", clientAlgoId: ids.tp2ClientAlgoId,
            childOrderId: tp2Ev.childOrderId, qty: tp2Ev.fillQty ?? 0, price: tp2Ev.fillPrice,
          }).catch(() => undefined);
        }
        await db.position.update({ where: { id: pos.id }, data: { tp2FilledAt: new Date() } }).catch(() => undefined);
      }
      return;
    }
    // Legacy 40/30/runner: TP1 selesai hanya bila fill aktual >= target fase.
    if (pos.tp1FilledAt == null && tp1Ev.confirmedFilled && tp1PhaseComplete) {
      await db.position.update({
        where: { id: pos.id },
        data: { tp1FilledAt: new Date(), tp1FillPrice: tp1Ev.fillPrice ?? pos.tp1Price ?? undefined },
      }).catch(() => undefined);
    }
    const tpMaxId = `TPM_${entry.clientOrderId}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 36);
    if (pos.tp2FilledAt != null) {
      if (plan?.tpMaxPrice) await this.ensureRunnerTakeProfit(pos, tpMaxId, plan.tpMaxPrice, plan.runnerQty);
      return;
    }
    const tp2 = await liveExchange.queryAlgo(ids.tp2ClientAlgoId).catch(() => null);
    const tp2Ev = parseAlgoFillEvidence(tp2);
    if (!tp2Ev.confirmedFilled) return;
    // Legacy ladder fallback only; RR23 returns before this branch (no runner).
    const runnerQty = plan?.runnerQty ?? Number(pos.qty) * 0.3;
    if (!(runnerQty > 0)) return;
    const now = new Date();
    await db.position.update({
      where: { id: pos.id },
      data: {
        tp2FilledAt: now,
        qty: runnerQty,
        notional: runnerQty * pos.entryPrice,
        marginUsd: (runnerQty * pos.entryPrice) / Math.max(1, pos.leverage ?? 1),
      },
    }).catch(() => undefined);
    const updated = { ...pos, qty: runnerQty, tp2FilledAt: now } as PositionRow;
    let beMoved = true;
    await moveSlToBeLive(updated).catch((err) => {
      beMoved = false;
      logger.warn({ positionId: pos.id, symbol: pos.symbol, err: (err as Error)?.message }, "LADDER_BE_MOVE_FAILED");
    });
    if (plan?.tpMaxPrice) {
      await this.ensureRunnerTakeProfit(updated, tpMaxId, plan.tpMaxPrice, plan.runnerQty);
    }
    await db.eventLog.create({
      data: {
        type: "LADDER_TP2_BE_LIVE",
        severity: beMoved ? "info" : "warn",
        payload: JSON.stringify({
          positionId: pos.id, symbol: pos.symbol, runnerQty,
          tpMaxPrice: plan?.tpMaxPrice ?? null, beMoved,
        }),
      },
    }).catch(() => undefined);
  }

  /** Pasang TPMAX runner sekali saja; query dulu supaya restart tidak menduplikasi. */
  private async ensureRunnerTakeProfit(
    pos: PositionRow, clientAlgoId: string, price: number, qty: number,
  ): Promise<void> {
    if (!liveExchange || !(qty > 0) || !(price > 0)) return;
    const existing = await liveExchange.queryAlgo(clientAlgoId).catch(() => null);
    if (existing) return; // resting ATAU sudah tereksekusi — jangan pasang ulang
    const tick = pos.priceTick && pos.priceTick > 0
      ? pos.priceTick
      : Math.max(price * 1e-10, 1e-12);
    const level = roundToTick(price, tick);
    try {
      await liveExchange.placeReduceOnlyGuard({
        symbol: pos.symbol,
        side: pos.side === "LONG" ? "SELL" : "BUY",
        type: "TAKE_PROFIT",
        triggerPrice: level,
        price: level,
        quantity: qty,
        clientAlgoId,
      });
      logger.info({ positionId: pos.id, symbol: pos.symbol, level, qty }, "LADDER_TPMAX_PLACED");
    } catch (err) {
      logger.warn({ positionId: pos.id, symbol: pos.symbol, err: (err as Error)?.message }, "LADDER_TPMAX_FAILED");
    }
  }

  /** Posisi exchange sudah flat; akuntansi baris DB.
   * CP-1 (12 Okt 2026, perintah operator): harga exit, realized PnL, komisi, dan
   * funding diambil dari FILL ASLI exchange (GET /fapi/v1/userTrades +
   * /fapi/v1/income), BUKAN harga trigger. Bukti tak lengkap atau ambigu menunda
   * finalisasi; tidak ada asumsi harga SL maupun realisasi loss. Duplikasi
   * ledger dicegah: Trade unik per positionId dan
   * transaksi mengecek baris yang sudah ada sebelum menulis. */
  private async finalizeClosedPosition(pos: PositionRow, _markFallback: number): Promise<"CLOSED" | "DEFERRED"> {
    // 30 Okt 2026 (Tahap 0): setiap jalur kini ter-log — masuk, defer (+alasan),
    // error (+fase), hasil. Insiden #3239/#3240 meninggalkan NOL jejak; itu yang
    // dikunci di sini. Logika akuntansi CP-1 tidak berubah.
    const startedAt = Date.now();
    let phase = "fetchEvidence";
    logger.info({ positionId: pos.id, symbol: pos.symbol }, "LIVE_EXIT_FINALIZE_START");
    try {
    const evidence = await this.fetchExchangeExitEvidence(pos);
    if (!evidence?.complete || evidence.attribution === "AMBIGUOUS" ||
        !Number.isFinite(evidence.exitAvg) || !(evidence.exitAvg && evidence.exitAvg > 0) ||
        !Number.isFinite(evidence.filledQty) || !(evidence.filledQty > 0)) {
      const deferReason = !evidence ? "EVIDENCE_UNAVAILABLE"
        : !evidence.complete ? "INCOMPLETE_FILLS"
        : evidence.attribution === "AMBIGUOUS" ? "AMBIGUOUS_ATTRIBUTION"
        : "EXIT_PRICE_OR_QTY_INVALID";
      const last = this.accountingDeferredAt.get(pos.id) ?? 0;
      const eventWritten = Date.now() - last >= 60_000;
      if (eventWritten) {
        this.accountingDeferredAt.set(pos.id, Date.now());
        await db.eventLog.create({ data: { type: "LIVE_EXIT_ACCOUNTING_DEFERRED", severity: "warn",
          payload: JSON.stringify({ positionId: pos.id, symbol: pos.symbol, reason: "ATTRIBUTABLE_EXIT_FILLS_UNAVAILABLE", deferReason }) } });
      }
      // Dulu senyap di journal (hanya EventLog ber-dedup) — tak ada jejak sama
      // sekali saat watcher gagal. Kini setiap deferral ter-log dengan alasan.
      logger.warn({ positionId: pos.id, symbol: pos.symbol, deferReason, eventWritten }, "LIVE_EXIT_ACCOUNTING_DEFERRED");
      return "DEFERRED"; // Flat exposure does not establish a price, PnL or realized loss.
    }
    phase = "decide";
    const decision = decideExitAccounting({
      pos: { side: pos.side as "LONG" | "SHORT", entryPrice: pos.entryPrice, qty: pos.originalQty ?? pos.qty },
      exchange: evidence,
      // Required by the pure accounting API; usable evidence above guarantees
      // EXCHANGE_FILLS, and even this unused fallback is an actual fill price.
      fallback: { price: evidence.exitAvg, reason: "SL" },
    });
    // Fee penuh (18 Okt 2026): realizedPnlUsd dari exchange masih GROSS (exitAccounting
    // docs). DB menyimpan NET = gross - fee + funding (konvensi db di config/costs.ts).
    // rMultiple tetap R basis jarak harga GROSS supaya makna 2R/3R ladder tetap berlaku.
    const grossRealized = decision.realizedPnlUsd;
    const realized = netRealizedPnlUsd(grossRealized, decision.feeUsd, decision.fundingUsd);
    const directional = pos.side === "LONG" ? 1 : -1;
    const originalQty = pos.originalQty ?? pos.qty;
    const originalSl = pos.originalSlPrice ?? pos.slPrice;
    const risk = pos.originalRiskUsd ?? Math.abs(pos.entryPrice - originalSl) * originalQty;
    const rMultiple = risk > 0 ? Number((grossRealized / risk).toFixed(4)) : 0;
    const riskDistance = risk > 0 && originalQty > 0 ? risk / originalQty : 0;
    phase = "transaction";
    const trade = await db.$transaction(async (tx) => {
      const existing = await tx.trade.findUnique({ where: { positionId: pos.id } });
      if (existing) return existing;
      await tx.position.update({
        where: { id: pos.id },
        data: {
          status: "CLOSED", closedAt: new Date(), closeReason: decision.closeReason,
          pnlUsd: realized, pnlR: rMultiple, qty: 0, notional: 0, marginUsd: 0,
          realizedPnlUsd: realized,
        },
      });
      return tx.trade.create({
        data: {
          positionId: pos.id, symbol: pos.symbol, mode: pos.mode, side: pos.side,
          riskUsd: risk, riskBudgetUsd: pos.riskBudgetUsd ?? null,
          entryAvg: pos.entryPrice, exitAvg: decision.exitPrice,
          rMultiple, pnlUsd: realized, feeUsd: decision.feeUsd, fundingUsd: decision.fundingUsd,
          win: realized > 0,
          mfeR: riskDistance > 0 ? Math.max(0, directional * ((pos.mfePrice ?? pos.entryPrice) - pos.entryPrice) / riskDistance) : 0,
          maeR: riskDistance > 0 ? Math.max(0, -directional * ((pos.maePrice ?? pos.entryPrice) - pos.entryPrice) / riskDistance) : 0,
          excursionsVerified: pos.mfePrice != null && pos.maePrice != null,
          accountingQuality: decision.quality, fundingVerified: decision.fundingVerified,
          holdMinutes: Math.max(0, Math.round((Date.now() - pos.openedAt.getTime()) / 60000)),
          strategyId: pos.strategyId ?? null, zoneType: pos.zoneType ?? null,
          source: pos.source ?? "LIVE_AI", entryAttrs: pos.entryAttrs ?? null,
        },
      });
    });
    phase = "postClose";
    this.slAlgoByPosition.delete(pos.id);
    this.accountingDeferredAt.delete(pos.id);
    await updateClosedDirectionBattle(pos.id).catch(() => undefined);
    // Fase 2 (13 Okt): posisi flat terkonfirmasi exchange -> bersihkan proteksi
    // sibling (SLA_/TPA_) milik trade ini. Root cause insiden orphan: baris ini
    // tidak ada. Idempotent, fail-open (lihat liveBracketCleanup).
    await liveBracketCleanup(pos, decision.closeReason);
    // 11 Okt 2026 — cooldown pasca-LOSS global (audit 5 Whys): catat loss LIVE juga.
    // 13 Okt 2026 — closeReason "SL" memicu blokir panjang 60 menit (perintah operator).
    try { lossCooldownGuard.recordClose(realized > 0, undefined, decision.closeReason); } catch { /* best-effort */ }
    await db.eventLog.create({
      data: {
        type: "LIVE_POSITION_CLOSED",
        severity: "info",
        payload: JSON.stringify({ positionId: pos.id, symbol: pos.symbol, closeReason: decision.closeReason, exitPrice: decision.exitPrice, pnlUsd: realized, feeUsd: decision.feeUsd, fundingUsd: decision.fundingUsd, quality: decision.quality, basis: decision.basis, attribution: decision.attribution, note: decision.note, feeVerified: decision.feeVerified, rMultiple, tradeId: trade.id }),
      },
    });
    logger.info({ positionId: pos.id, symbol: pos.symbol, reason: decision.closeReason, exitPrice: decision.exitPrice, pnlUsd: realized, feeUsd: decision.feeUsd, quality: decision.quality, basis: decision.basis, attribution: decision.attribution, note: decision.note, finalizeMs: Date.now() - startedAt }, "LIVE_POSITION_CLOSED");
    return "CLOSED";
    } catch (err) {
      // Tahap 0: error finalisasi dulu bercampur dengan error tick biasa tanpa
      // identitas posisi/fase. Log + EventLog khusus, lalu lempar ulang supaya
      // klasifikasi onTickError (rate-limit vs gagal) tetap sama seperti dulu.
      logger.warn({ err: (err as Error)?.message, positionId: pos.id, symbol: pos.symbol, phase }, "LIVE_EXIT_FINALIZE_ERROR");
      void db.eventLog.create({ data: { type: "LIVE_EXIT_FINALIZE_ERROR", severity: "warn",
        payload: JSON.stringify({ positionId: pos.id, symbol: pos.symbol, phase, err: (err as Error)?.message }) } }).catch(() => undefined);
      throw err;
    }
  }

  /** Bukti exit dari exchange (READ-ONLY): fill asli + funding. null = gagal /
   * tidak tersedia / pagination terpotong -> caller memakai fallback ESTIMATED.
   * Tidak ada order. (Review 12 Okt: pagination cap dengan halaman terakhir
   * penuh = data mungkin tidak lengkap -> bukti DITOLAK, tidak pernah VERIFIED.) */
  private async fetchExchangeExitEvidence(pos: PositionRow): Promise<(AggregatedExit & { fundingUsd: number; fundingVerified: boolean }) | null> {
    if (!liveExchange) {
      logger.warn({ symbol: pos.symbol, positionId: pos.id, reason: "NO_LIVE_EXCHANGE" }, "LIVE_EXIT_EVIDENCE_UNAVAILABLE");
      return null;
    }
    try {
      const openedMs = pos.openedAt.getTime();
      const window = await fetchUserTradesWindow(liveExchange, pos.symbol, openedMs - 10 * 60_000, Date.now() + 60_000);
      if (window.truncated) {
        logger.warn({ symbol: pos.symbol, positionId: pos.id }, "LIVE_EXIT_USERTRADES_TRUNCATED");
        return null;
      }
      const agg = aggregateExitFills({
        posSide: pos.side as "LONG" | "SHORT", posQty: pos.originalQty ?? pos.qty, openedAtMs: openedMs, rows: window.rows,
      });
      let fundingUsd = 0;
      let fundingVerified = false;
      try {
        const income = await liveExchange.getIncome({
          symbol: pos.symbol, incomeType: "FUNDING_FEE",
          startTime: openedMs - 60_000, endTime: Date.now() + 60_000, limit: 1000,
        });
        fundingUsd = income.reduce((sum, row) => {
          const v = Number(row.income);
          return Number.isFinite(v) ? sum + v : sum;
        }, 0);
        // >= 1000 baris = hasil mungkin terpotong limit -> funding TIDAK
        // terverifikasi walau tetap dijumlahkan (review 12 Okt kriteria 4).
        fundingVerified = income.length < 1000;
      } catch { fundingVerified = false; }
      // Tahap 0: ringkasan bukti yang terbaca — dulu tidak terlihat sama sekali,
      // sekarang jejaknya bisa dibandingkan dengan userTrades/income saat audit.
      logger.info({ symbol: pos.symbol, positionId: pos.id, rows: window.rows.length,
        complete: agg.complete, attribution: agg.attribution, exitAvg: agg.exitAvg,
        filledQty: agg.filledQty, exitFillCount: agg.exitFillCount, fundingUsd, fundingVerified },
        "LIVE_EXIT_EVIDENCE");
      return { ...agg, fundingUsd, fundingVerified };
    } catch (err) {
      logger.warn({ err: (err as Error)?.message, symbol: pos.symbol, positionId: pos.id }, "LIVE_EXIT_FILLS_UNAVAILABLE");
      return null;
    }
  }

}

export const livePositionWatcher = new LivePositionWatcher();

// ── Orphan SL/TP cleanup (13 Okt 2026, insiden Position 3028/3029) ─────────
// Posisi FLAT (bukti exchange, bukan DB) = proteksi sibling milik trade ini
// (algo SLA_/TPA_ dari preEntryBracket) WAJIB dibatalkan + diverifikasi.
// Root cause insiden: jalur penutupan (native SL/TP fill, watcher, supervisor,
// watchdog, manual) tidak pernah membatalkan sibling. Fungsi ini TITIK TUNGGAL
// yang dipanggil dari finalizeClosedPosition (native close) dan hook supervisor
// (exit executor). Idempotent + fail-open: kegagalan dilaporkan, tidak pernah
// mengganggu jalur akuntansi; sweep startup & watchdog menutup sisanya.
export const bracketCleanupRepo = {
  async findEntryByPositionId(positionId: number): Promise<{ clientOrderId: string; reduceOnly: boolean } | null> {
    const row = await db.orderExec.findFirst({
      where: { positionId, reduceOnly: false },
      orderBy: { id: "asc" },
      select: { clientOrderId: true, reduceOnly: true },
    });
    return row ?? null;
  },
};

export async function liveBracketCleanup(
  pos: { id: number; symbol: string; source?: string | null }, reason: string,
): Promise<void> {
  if (!LIVE_MODE || !liveExchange) return; // PAPER: supervisor virtual, tak ada algo exchange.
  if (pos.source != null && !pos.source.startsWith("LIVE_")) return;
  try {
    const result = await cleanupProtectiveOrders({
      ex: liveExchange, repo: bracketCleanupRepo, symbol: pos.symbol, positionId: pos.id,
    });
    if (!result.flatVerified) {
      logger.warn({ symbol: pos.symbol, positionId: pos.id, reason: result.reason, cleanupReason: reason },
        "BRACKET_CLEANUP_NOT_FLAT_TIDAK_ADA_AKSI");
      return;
    }
    for (const c of result.cancelled) {
      const event = c.confirmed ? "BRACKET_SIBLING_CANCELLED" : "BRACKET_SIBLING_CANCEL_UNCONFIRMED";
      (c.confirmed ? logger.info : logger.warn)({ symbol: pos.symbol, positionId: pos.id, reason, ...c }, event);
      await db.eventLog.create({
        data: { type: event, severity: c.confirmed ? "info" : "warn",
          payload: JSON.stringify({ positionId: pos.id, symbol: pos.symbol, reason, ...c }) },
      }).catch(() => undefined);
    }
    for (const s of result.skipped) {
      logger.warn({ symbol: pos.symbol, positionId: pos.id, reason, ...s }, "BRACKET_SIBLING_AMBIGUOUS_TIDAK_DIBATALKAN");
      await db.eventLog.create({
        data: { type: "BRACKET_SIBLING_AMBIGUOUS", severity: "warn",
          payload: JSON.stringify({ positionId: pos.id, symbol: pos.symbol, reason, ...s }) },
      }).catch(() => undefined);
    }
  } catch (err) {
    logger.error({ symbol: pos.symbol, positionId: pos.id, reason, err: (err as Error)?.message },
      "BRACKET_CLEANUP_FAILED");
  }
}

// ── 15 Okt 2026 — LIVE: SL → BE setelah TP2 ladder terisi (ladder TP SWING) ──
// Dipanggil via supervisor setBeMoveHook (index.ts, LIVE saja). Pasang+verifikasi
// replacement lebih dulu, baru batalkan SL trade yang sama. Kegagalan sebelum
// verifikasi mempertahankan stop lama dan tidak mengklaim BE di ledger.
export type BreakevenStopExchange = Pick<BinanceUsdMClient,
  "getOpenAlgoOrders" | "placeReduceOnlyGuard" | "queryAlgo" | "cancelAlgo" | "getPositionRisk">;

/** Inert until explicitly called; dependencies are injectable for offline tests.
 * Replacement first, ownership by entry reference + symbol, terminal cancel query.
 * Any placement/query failure leaves the known old protection untouched. */
export async function replaceOwnedStopAtBreakeven(input: {
  pos: Pick<PositionRow, "id" | "symbol" | "side" | "entryPrice" | "qty" | "priceTick">;
  entryClientOrderId: string; client: BreakevenStopExchange; now?: () => number;
}): Promise<{ clientAlgoId: string; oldCancellationConfirmed: boolean }> {
  const { pos, client } = input;
  if (!(pos.qty > 0) || !(pos.entryPrice > 0) || !input.entryClientOrderId) throw new Error("BE_POSITION_INVALID");
  const originalStopId = bracketAlgoIds(input.entryClientOrderId).slClientAlgoId;
  const rows = await client.getOpenAlgoOrders();
  const owned = rows.filter((raw) => {
    const row = raw as { symbol?: string; clientAlgoId?: string };
    return row.symbol === pos.symbol && typeof row.clientAlgoId === "string" &&
      (row.clientAlgoId === originalStopId || row.clientAlgoId.startsWith(`SLB_BE_${pos.id}_`));
  }) as Array<{ clientAlgoId: string }>;
  if (owned.length === 0) throw new Error("BE_OWNED_STOP_UNAVAILABLE");
  const clientAlgoId = `SLB_BE_${pos.id}_${(input.now ?? Date.now)().toString(36)}`;
  const tick = pos.priceTick && pos.priceTick > 0 ? pos.priceTick : Math.max(pos.entryPrice * 1e-10, 1e-12);
  const check = (row: { clientAlgoId?: string; symbol?: string; triggerPrice?: string; algoStatus?: string }) =>
    row.clientAlgoId === clientAlgoId && row.symbol === pos.symbol &&
    ["NEW", "WORKING", "ACTIVE"].includes(String(row.algoStatus).toUpperCase()) &&
    Number.isFinite(Number(row.triggerPrice)) && Math.abs(Number(row.triggerPrice) - pos.entryPrice) <= tick;
  const replacement = await client.placeReduceOnlyGuard({ symbol: pos.symbol,
    side: pos.side === "LONG" ? "SELL" : "BUY", type: "STOP_MARKET",
    triggerPrice: pos.entryPrice, quantity: pos.qty, clientAlgoId });
  if (!replacement || !check(replacement)) throw new Error("BE_STOP_NOT_ECHOED");
  if (!check(await client.queryAlgo(clientAlgoId))) throw new Error("BE_STOP_NOT_VERIFIED");
  let oldCancellationConfirmed = true;
  for (const old of owned) {
    if (old.clientAlgoId === clientAlgoId) continue;
    const result = await cancelWithConfirmation(client, old.clientAlgoId);
    oldCancellationConfirmed &&= result.confirmed;
  }
  return { clientAlgoId, oldCancellationConfirmed };
}

export async function moveSlToBeLive(pos: PositionRow): Promise<void> {
  if (!LIVE_MODE || !liveExchange || !String(pos.source ?? "").startsWith("LIVE_")) return;
  const entry = await bracketCleanupRepo.findEntryByPositionId(pos.id);
  if (!entry || entry.reduceOnly || entry.clientOrderId.startsWith("SIM_")) throw new Error("BE_ENTRY_IDENTITY_UNAVAILABLE");
  const replacement = await replaceOwnedStopAtBreakeven({ pos, entryClientOrderId: entry.clientOrderId, client: liveExchange });
  logger.info({ positionId: pos.id, symbol: pos.symbol, bePrice: pos.entryPrice, qty: pos.qty }, "SL_MOVED_BE_LIVE");
  await db.eventLog.create({
    data: { type: "SL_MOVED_BE_LIVE", severity: "info",
      payload: JSON.stringify({ positionId: pos.id, symbol: pos.symbol, bePrice: pos.entryPrice, qty: pos.qty,
        clientAlgoId: replacement.clientAlgoId, oldCancellationConfirmed: replacement.oldCancellationConfirmed }) },
  }).catch(() => undefined);
}

// ── T-05: boot reconciliation source (G4, 25 Okt 2026) ────────────────────
// G4: sumber ini dulu di-gate `LIVE_MODE && liveExchange` di sini + index.ts,
// sehingga branch ORPHAN (exec/reconciler.ts) TIDAK PERNAH jalan saat PAPER —
// 4 posisi exchange live (GTC/WLD/BOME/MOODENG) tidak dikenal bot sama sekali.
// Reconciler harus mode-independent: getPositionRiskAll = GET signed saja,
// tidak mengirim order, aman dipakai PAPER (pola yang sama dengan
// liveMirror.readClient() — preseden G5-b). Yang tetap di-gate LIVE adalah
// jalur yang MENULIS (liveOrderExecutor, watcher, flatten, kill switch).
const reconcileClient: BinanceUsdMClient | null = liveExchange
  ?? (env.BINANCE_API_KEY && env.BINANCE_API_SECRET
    ? new BinanceUsdMClient({ apiKey: env.BINANCE_API_KEY, apiSecret: env.BINANCE_API_SECRET })
    : null);

export const exchangeReconcileSource = reconcileClient
  ? {
      async getOpenPositions() {
        const rows = await reconcileClient.getPositionRiskAll();
        const out: Array<{ symbol: string; positionAmt: number; entryPrice: number; markPrice: number }> = [];
        for (const r of rows) {
          const amt = Number(r.positionAmt);
          if (!Number.isFinite(amt) || amt === 0) continue;
          out.push({
            symbol: r.symbol,
            positionAmt: amt,
            entryPrice: Number(r.entryPrice ?? 0),
            markPrice: Number(r.markPrice ?? 0),
          });
        }
        return out;
      },
    }
  : undefined;

// ── T-09: liveReady — kondisi, bukan hardcode ──────────────────────────────
/** Sinkron & murah (untuk /api/health & /api/settings): mode LIVE + ARM. */
export function liveReadyNow(): boolean {
  return LIVE_MODE && defaultDailyRiskGuard.isArmed();
}

/** Async + balance (untuk keputusan yang butuh saldo riil). */
export async function computeLiveReady(): Promise<boolean> {
  if (!liveReadyNow()) return false;
  const balance = await fetchLiveBalanceUsd().catch(() => null);
  return balance !== null && balance >= env.LIVE_MIN_BALANCE_USD;
}

// ── T-02d: flatten satu simbol (fail-closed: proteksi hilang = posisi ditutup) ──
/** Tutup posisi satu simbol di market (reduceOnly). Dipakai bila bracket
 *  pre-entry gagal setelah fill — posisi TIDAK boleh dibiarkan tanpa SL. */
export async function flattenLiveSymbol(input: {
  symbol: string; side: "LONG" | "SHORT"; qty: number; reason: string;
}): Promise<void> {
  logger.error({ symbol: input.symbol, reason: input.reason }, "LIVE_FLATTEN_SYMBOL");
  if (!LIVE_MODE || !liveExchange) return;
  try {
    const hub = Number(binanceFuturesClient.getHubPrices([input.symbol]).map[input.symbol]?.m ?? 0);
    await liveOrderExecutor.executeOrder({
      clientOrderId: `FLAT_${input.symbol}_${Date.now()}`.slice(0, 36),
      symbol: input.symbol,
      side: input.side === "LONG" ? "SELL" : "BUY",
      type: "MARKET",
      price: hub > 0 ? hub : 1,
      qty: input.qty,
      reduceOnly: true,
    });
  } catch (err) {
    logger.error({ symbol: input.symbol, err: (err as Error)?.message }, "LIVE_FLATTEN_FAILED");
  }
  await db.eventLog.create({
    data: {
      type: "LIVE_FLATTEN_SYMBOL",
      severity: "error",
      payload: JSON.stringify({ symbol: input.symbol, side: input.side, qty: input.qty, reason: input.reason }),
    },
  });
}

// ── T-07: kill switch LIVE — cancel semua algo + flat semua posisi market ──
export async function liveEmergencyFlatten(): Promise<{ cancelledAlgos: number; closedSymbols: string[] }> {
  if (!LIVE_MODE || !liveExchange) return { cancelledAlgos: 0, closedSymbols: [] };
  const cancelledAlgos: string[] = [];
  const closedSymbols: string[] = [];
  try {
    const openAlgos = await liveExchange.getOpenAlgoOrders();
    for (const algo of openAlgos) {
      const cid = String((algo as { clientAlgoId?: string }).clientAlgoId ?? "");
      if (!cid) continue;
      try {
        await liveExchange.cancelAlgo(cid);
        cancelledAlgos.push(cid);
      } catch (err) {
        logger.warn({ err: (err as Error)?.message, algo: cid }, "LIVE_KILL_CANCEL_ALGO_FAILED");
      }
    }
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, "LIVE_KILL_LIST_ALGOS_FAILED");
  }
  try {
    const positions = await liveExchange.getPositionRiskAll();
    for (const p of positions) {
      const amt = Number(p.positionAmt);
      if (!Number.isFinite(amt) || amt === 0) continue;
      const side = amt > 0 ? "SELL" : "BUY";
      const refPrice = Number(p.entryPrice ?? 0) > 0 ? Number(p.entryPrice) : 1;
      try {
        await liveExchange.postOrder({
          clientOrderId: `KILL_${p.symbol}_${Date.now()}`.slice(0, 36),
          symbol: p.symbol, side, type: "MARKET", price: refPrice, qty: Math.abs(amt), reduceOnly: true,
        });
        closedSymbols.push(p.symbol);
      } catch (err) {
        logger.warn({ err: (err as Error)?.message, symbol: p.symbol }, "LIVE_KILL_CLOSE_FAILED");
      }
    }
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, "LIVE_KILL_LIST_POSITIONS_FAILED");
  }
  await db.eventLog.create({
    data: {
      type: "LIVE_KILL_SWITCH",
      severity: "error",
      payload: JSON.stringify({ cancelledAlgos, closedSymbols }),
    },
  });
  return { cancelledAlgos: cancelledAlgos.length, closedSymbols };
}
