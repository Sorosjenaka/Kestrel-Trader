import { usesSwingRr23, SWING_RR23, type ExitPolicyPosition } from "../strategies/swing/researchExitPolicy.js";
// apps/server/src/exec/positionSupervisor.ts - Supervisor exit SWING (DUAL policy di bawah), single-target utk SCALP, SL statis, funding-aware.
// DUA kebijakan exit SWING (pemilih: researchExitPolicy.usesSwingRr23):
//  (A) RR23 / 1:3 — untuk NEW SWING PAPER/LIVE versioned (entryAttrs.swingExitPolicy
//      = SWING_50_2R_BE_50_3R_V1): TP1 (LIMIT) tutup 50% di 2R, SL pindah ke BE
//      (entry), sisa 50% berjalan ke TP2/final di 3R (tanpa runner terpisah).
//  (B) LEGACY 40/30/BE/TPmax — hanya untuk posisi lama tanpa marker RR23:
//      TP1 40% @5/3R, TP2 30% @10/3R, BE setelah TP2, sisa 30% @5R.
// Kedua path tetap fungsional agar posisi lama tidak berubah. SCALP tetap SINGLE-TARGET.
// Perintah operator 30 Sep 2026 (SL-fill): "SL nya malah jadi melebar ... terkecuali da fake out
// yang luar biasa." SL dieksekusi DI HARGA SL (resting stop-market), bukan di harga pasar saat
// terdeteksi. Pengecualian tunggal: gap/fakeout luar biasa — sejak fix 9 Okt 2026 (kasus JCTUSDT
// #2760: supervisor telat mengamati ~10 mnt sehingga overrun 5.81R salah dikira gap pasar dan
// ter-fill -6.81R) pengecualian itu WAJIB TERBUKTI dari kline 1m: hanya bar yang TERBUKA sudah
// melewati level SL (harga tidak pernah diperdagangkan di level SL) yang boleh fill di harga gap.
// Overrun besar yang kline-nya menunjukkan level SL DIPERDAGANGKAN = gap observasi supervisor,
// fill tetap DI HARGA SL (audit: SL_OBSERVATION_GAP_FILL). Tanpa data kline, aturan dasar menang:
// fill di harga SL (fail-closed).
import { db } from "../core/db.js";
import { binanceFuturesClient } from "../markets/binanceFuturesClient.js";
import { env } from "../core/env.js";
import { OrderExecutor, defaultOrderExecutor, paperPositionExecutor, type ExecutionResult, type OrderCancellationResult } from "./orderExecutor.js";
import { activeOrderExecutor } from "./liveRuntime.js";
import { trendFlipSideCooldown } from "./slotFillPolicy.js";
import { autoRollbackRuleIfNeeded, prismaPlaybookRuleStore, recordApprovedRuleOutcomeForTrade } from "../learning/playbookRules.js";
import { updateClosedDirectionBattle } from "../learning/directionBattleLearning.js";
import { SWING_TP1_FRAC, SWING_TP2_FRAC } from "../strategies/swingBreakoutEngine.js";

export type PositionStatus = "OPEN" | "CLOSED";
export type PositionSide = "LONG" | "SHORT";
// 30 Sep 2026 — refactor SCALP-only: mode tunggal. Trade historis lama
// tetap bisa ditutup (mode dibaca dari DB, bukan diproduksi).
export type TradingMode = "SCALP";
// 15 Okt 2026 — ladder SWING: TP2 & TPMAX kembali sebagai fase exit (LIMIT).
export type CloseReason = "TP1" | "TP2" | "TPMAX" | "SL" | "FUNDING" | "KILL" | "LIQ_GAP" | "TREND_FLIP";

/** Legacy TPMAX ladder: offset TP1 = R×5/3 ⇒ TPMAX (R×5) = 3×offset.
 *  For RR23 this function returns the stored TP2 (final 3R) instead. */
export function swingTpMaxPrice(pos: Pick<PositionRow, "side" | "entryPrice" | "tp1Price"> & ExitPolicyPosition & { tp2Price?: number | null }): number {
  const offset = Math.abs(pos.tp1Price - pos.entryPrice);
  if (usesSwingRr23(pos) && Number.isFinite(pos.tp2Price) && (pos.side === "LONG" ? pos.tp2Price! > pos.tp1Price : pos.tp2Price! < pos.tp1Price)) return pos.tp2Price!;
  const multiple = usesSwingRr23(pos) ? 1.5 : 3;
  return pos.side === "LONG" ? pos.entryPrice + multiple * offset : pos.entryPrice - multiple * offset;
}

/** Ladder aktif untuk SEMUA posisi SWING (perintah operator 15 Okt sore). */
export function isLadderPosition(pos: Pick<PositionRow, "mode" | "side" | "tp1Price" | "tp2Price">): boolean {
  return String(pos.mode).toUpperCase() === "SWING";
}

/**
 * Level ladder SWING. RR23: TP2 = TPMAX = stored final 3R. Legacy positions
 * (no marker) keep TP2 from DB or derive it from TP1 offset; TPMAX = 3×offset.
 */
export function swingLadderLevels(pos: Pick<PositionRow, "mode" | "side" | "entryPrice" | "tp1Price" | "tp2Price"> & ExitPolicyPosition): { tp2: number; tpMax: number } {
  const offset = Math.abs(pos.tp1Price - pos.entryPrice);
  if (usesSwingRr23(pos)) return { tp2: swingTpMaxPrice(pos), tpMax: swingTpMaxPrice(pos) };
  const tp2Stored = pos.tp2Price;
  const tp2 = tp2Stored != null && Number.isFinite(tp2Stored) && Math.abs(tp2Stored - pos.tp1Price) > 1e-9
    ? tp2Stored
    : pos.side === "LONG" ? pos.entryPrice + 2 * offset : pos.entryPrice - 2 * offset;
  return { tp2, tpMax: swingTpMaxPrice(pos) };
}

// Estimasi harga liquidation isolated-margin (cermin formula riskEngine, MMR 1%).
// Dipakai HANYA bila MARGIN_MODE=ISOLATED. Mode default adalah CROSS (di bawah).
export function estimateLiquidationPrice(entryPrice: number, leverage: number, side: PositionSide | string): number {
  const lev = Math.max(1, Number(leverage) || 25);
  const mmr = 0.01;
  return side === "LONG"
    ? Number((entryPrice * (1 - 1 / lev) / (1 - mmr)).toFixed(6))
    : Number((entryPrice * (1 + 1 / lev) / (1 + mmr)).toFixed(6));
}

/** Informational pro-rata stress scenario, NOT an exchange liquidation price.
 * Omits other-position unrealized PnL, maintenance tiers and wallet adjustments.
 * The supervisor deliberately never uses this approximation as an exit trigger.
 */
export function estimateCrossLiqPrice(
  entryPrice: number,
  side: PositionSide | string,
  equityUsd: number,
  totalNotionalUsd: number,
  positionNotionalUsd: number,
  mmrRate = 0.01
): number | null {
  if (!(entryPrice > 0) || !(equityUsd > 0) || !(totalNotionalUsd > 0) || !(positionNotionalUsd > 0)) return null;
  const buffer = equityUsd - mmrRate * totalNotionalUsd;
  if (!(buffer > 0)) return entryPrice; // ekuitas di bawah maintenance -> bahaya segera
  const qty = positionNotionalUsd / entryPrice;
  if (!(qty > 0)) return null;
  const maxAdv = (buffer * positionNotionalUsd) / totalNotionalUsd;
  const dist = maxAdv / qty;
  if (!Number.isFinite(dist) || dist < 0) return null;
  return Number((side === "LONG" ? entryPrice - dist : entryPrice + dist).toFixed(6));
}

/** true = mode CROSS (default perintah operator); false = ISOLATED eksplisit. */
export function isCrossMargin(mode?: string): boolean {
  return String(mode ?? env.MARGIN_MODE ?? "CROSS").toUpperCase() !== "ISOLATED";
}

export interface PositionRow {
  id: number;
  symbol: string;
  mode: TradingMode | string;
  side: PositionSide | string;
  entryPrice: number;
  qty: number;
  notional: number;
  leverage: number;
  marginUsd: number;
  slPrice: number;
  tp1Price: number;
  /** Legacy TP2 level; RR23 uses the stored final TP2 (3R), null/==tp1 = single-target. */
  tp2Price?: number | null;
  tp1FilledAt: Date | null;
  /** 19 Okt 2026 — ladder LIVE: TP2 algo FILLED (dipakai watcher utk BE+TPMAX). */
  tp2FilledAt?: Date | null;
  realizedPnlUsd: number;
  tp1FillPrice: number | null;
  status: PositionStatus | string;
  openedAt: Date;
  closedAt: Date | null;
  closeReason: CloseReason | string | null;
  pnlUsd: number | null;
  pnlR: number | null;
  outlookText: string;
  // ── Mesin setup (T-5.15) ──
  strategyId?: string | null;
  strategyName?: string | null;
  entryType?: string | null;
  zoneType?: string | null;
  zoneTop?: number | null;
  zoneBottom?: number | null;
  /** Provenance: LIVE_AI / MANUAL / DEMO (T-5.16). */
  source?: string | null;
  originalQty?: number | null;
  originalSlPrice?: number | null;
  originalRiskUsd?: number | null;
  /** Budget risiko NET ($) dari sizing — denominator R ternormalisasi (opsi b, 29 Sep 2026). */
  riskBudgetUsd?: number | null;
  entryFeeUsd?: number | null;
  entryFeeEstimated?: boolean | null;
  quantityStep?: number | null;
  priceTick?: number | null;
  mfePrice?: number | null;
  maePrice?: number | null;
  accountingVersion?: number | null;
  exitAccounting?: string | null;
  marginMode?: string | null;
  /** T-01 (4 Okt 2026): snapshot atribut trigger & kondisi market saat entry (JSON teks). */
  entryAttrs?: string | null;
}

export interface TradeRow {
  id?: number;
  positionId: number;
  symbol: string;
  mode: string;
  side: string;
  riskUsd: number;
  /** Budget risiko NET ($) saat entry; null = legacy tanpa catatan budget. */
  riskBudgetUsd?: number | null;
  entryAvg: number;
  exitAvg: number;
  rMultiple: number;
  pnlUsd: number;
  feeUsd: number;
  fundingUsd: number;
  win: boolean;
  mfeR: number;
  maeR: number;
  holdMinutes: number;
  createdAt?: Date;
  strategyId?: string | null;
  zoneType?: string | null;
  /** Provenance trade (mewarisi source posisi). */
  source?: string | null;
  accountingQuality?: string;
  fundingVerified?: boolean;
  excursionsVerified?: boolean;
  /** T-01 (4 Okt 2026): salinan entryAttrs posisi (JSON teks). */
  entryAttrs?: string | null;
}

export interface PositionRepo {
  findOpenPositions(symbol?: string): Promise<PositionRow[]>;
  findById(id: number): Promise<PositionRow | null>;
  createPosition(data: Omit<PositionRow, "id">): Promise<PositionRow>;
  updatePosition(id: number, data: Partial<PositionRow>): Promise<PositionRow>;
  createTrade(data: TradeRow): Promise<TradeRow>;
  logEvent(action: string, symbol: string, payload: Record<string, unknown>): Promise<void>;
  // Penutupan atomik: update Position CLOSED + insert Trade dalam 1 transaksi.
  // Mencegah kejadian posisi CLOSED tapi trade=null (kasus SUI #209).
  closePositionWithTrade?(positionId: number, positionPatch: Partial<PositionRow>, trade: TradeRow): Promise<TradeRow>;
}

export interface MarkPriceTick {
  symbol: string;
  markPrice: number;
  timestamp?: number;
}

export interface FundingInfo {
  symbol: string;
  fundingRate: number; // e.g. 0.0001 (0.01%)
  nextFundingTime: number; // timestamp in ms
}

export interface SupervisorEvaluation {
  positionId: number;
  symbol: string;
  action: "TP1" | "TP2" | "TPMAX" | "SL" | "FUNDING" | "TREND_FLIP" | "NONE";
  price: number;
  reason?: string;
}

export class PositionSupervisor {
  private readonly repo: PositionRepo;
  private readonly locks = new Map<number, Promise<unknown>>();
  private readonly liquidationPriceProvider?: (position: PositionRow) => Promise<number | null>;
  private readonly executor: OrderExecutor;
  private readonly executorForPosition?: (position: PositionRow) => OrderExecutor;
  private readonly now: () => number;
  // Perintah operator 26 Sep 2026: exit FUNDING DIMATIKAN — iuran funding dibiarkan
  // dipotong otomatis oleh Binance saat live mainnet (bukan alasan menutup posisi).
  private readonly fundingExitEnabled: boolean;
  /** Override mode margin per-instance (test ISOLATED eksplisit; produksi ikut env). */
  private readonly marginMode?: string;
  // 15 Okt 2026 (Tahap 7): crossCache dihapus — dideklarasikan tapi tidak pernah
  // dibaca/ditulis (dead code sejak refactor supervisor single-target).
  /** Verifier gap SL berbasis kline (fix 9 Okt 2026); absen = perilaku legacy (fill pasar saat overrun). */
  private readonly gapVerifier?: SlGapVerifier;
  /** Hook pembersihan proteksi sibling (13 Okt, insiden orphan SL/TP): dipasang
   * index.ts (LIVE). Dipanggil SAAT posisi tertutup penuh via jalur exit executor
   * supervisor. Fail-open: error hook tidak pernah mengubah hasil exitFill. */
  private fullyClosedHook?: (pos: PositionRow, reason: string) => Promise<void>;

  /** Setelah updatePosition slPrice=BE, berikan salinan pos dengan SL baru ke hook. */
  private refreshedAfterBe(pos: PositionRow): PositionRow {
    return { ...pos, slPrice: pos.entryPrice };
  }

  /** Pasang hook cleanup (index.ts). Tidak mengubah perilaku PAPER/test. */
  setFullyClosedHook(hook: (pos: PositionRow, reason: string) => Promise<void>): void {
    this.fullyClosedHook = hook;
  }

  /** Hook pemindahan SL ke BE di LIVE (15 Okt, ladder TP SWING): setelah TP2
   * terisi, index.ts memasang implementasi yang membatalkan algo SL lama di
   * exchange dan menaruh STOP_MARKET reduceOnly baru di harga entry. Hook
   * ADDITIVE — di PAPER biarkan null (repo.updatePosition slPrice tetap jalan). */
  private beMoveHook?: (pos: PositionRow) => Promise<void>;

  setBeMoveHook(hook: (pos: PositionRow) => Promise<void>): void {
    this.beMoveHook = hook;
  }

  constructor(options?: {
    repo?: PositionRepo;
    liquidationPriceProvider?: (position: PositionRow) => Promise<number | null>;
    executor?: OrderExecutor;
    executorForPosition?: (position: PositionRow) => OrderExecutor;
    now?: () => number;
    /** Perintah operator 26 Sep 2026: exit FUNDING DIMATIKAN di produksi. */
    fundingExitEnabled?: boolean;
    /** Override mode margin (default dari env MARGIN_MODE; test memakai ISOLATED eksplisit). */
    marginMode?: string;
    /** Verifier gap SL (fix 9 Okt 2026): membedakan gap pasar sungguhan vs gap observasi supervisor. */
    gapVerifier?: SlGapVerifier;
  }) {
    this.repo = options?.repo ?? prismaPositionRepo;
    this.liquidationPriceProvider = options?.liquidationPriceProvider;
    this.executor = options?.executor ?? defaultOrderExecutor;
    this.executorForPosition = options?.executorForPosition;
    this.now = options?.now ?? Date.now;
    this.fundingExitEnabled = options?.fundingExitEnabled ?? true;
    this.marginMode = options?.marginMode;
    this.gapVerifier = options?.gapVerifier;
  }

  async evaluatePriceTick(tick: MarkPriceTick): Promise<SupervisorEvaluation[]> {
    if (!Number.isFinite(tick.markPrice) || tick.markPrice <= 0) return [];
    const results: SupervisorEvaluation[] = [];
    for (const snapshot of await this.repo.findOpenPositions(tick.symbol)) {
      await this.withPosition(snapshot.id, async (pos) => {
        const price = tick.markPrice;
        const long = pos.side === "LONG";
        // 15 Okt 2026 (fix #3177 SUIUSDT): uPnL/mfe/mae tetap mark-based (konvensi
        // lama); deteksi TP PAPER ditambah scan balik kline 1m sejak openedAt
        // (tpTouchedSinceOpen) karena sampling mark 1x/dtk bisa melewatkan wick.
        const mfePrice = long ? Math.max(pos.mfePrice ?? pos.entryPrice, price) : Math.min(pos.mfePrice ?? pos.entryPrice, price);
        const maePrice = long ? Math.min(pos.maePrice ?? pos.entryPrice, price) : Math.max(pos.maePrice ?? pos.entryPrice, price);
        if (mfePrice !== pos.mfePrice || maePrice !== pos.maePrice) {
          pos = await this.repo.updatePosition(pos.id, { mfePrice, maePrice });
        }
        // Recover missed PAPER exits in candle order before considering the
        // latest mark. A later TP must never erase an earlier stop wick.
        if (String(pos.source ?? "").startsWith("PAPER")) {
          const replay = await this.replayPaperCandles(pos, tick.timestamp ?? this.now());
          pos = replay.position;
          results.push(...replay.results);
          if (pos.status !== "OPEN") return;
        }
        await this.retryBreakeven(pos);
        pos = await this.repo.findById(pos.id) ?? pos;

        // An account-wide liquidation price requires exchange wallet/tier data.
        // Approximate isolated/cross helpers are informational, NEVER an exit trigger.
        const liq = await this.liquidationPriceProvider?.(pos).catch(() => null);
        if (liq != null && liq > 0 && (long ? price <= liq : price >= liq)) {
          const filled = await this.executeExitLocked(pos, price, "LIQ_GAP");
          if (filled) await this.repo.logEvent("LIQ_GAP_EXIT", pos.symbol, { positionId: pos.id, price, liquidationPrice: liq });
          results.push({ positionId: pos.id, symbol: pos.symbol, action: filled ? "SL" : "NONE", price, reason: "LIQ_GAP: authoritative liquidation boundary crossed" });
          return;
        }
        if (long ? price <= pos.slPrice : price >= pos.slPrice) {
          // 30 Sep 2026: SL mengikuti resting STOP_MARKET — fill di harga SL, bukan di harga
          // pasar yang sudah terlanjur jatuh saat terdeteksi (sampling delay ≠ realita pasar).
          // 9 Okt 2026: pengecualian gap WAJIB terverifikasi kline (resolveSlFill).
          const fill = await this.resolveSlFill(pos, price, tick.timestamp ?? this.now());
          const filled = await this.executeExitLocked(pos, fill.price, "SL");
          if (filled && fill.gap) {
            // Pengecualian tunggal "fake out yang luar biasa" — TERBUKTI dari kline (bar
            // pertama yang melewati SL terbuka sudah melewati level; level SL tak pernah
            // diperdagangkan). Fill di harga gap open, diaudit eksplisit.
            await this.repo.logEvent("SL_GAP_FILL", pos.symbol, {
              positionId: pos.id, slPrice: pos.slPrice, marketPrice: price, fillPrice: fill.price,
              overrunR: Number(fill.overrunR.toFixed(2)),
              note: "Gap sungguhan terverifikasi kline (bar terbuka melewati SL): fill di harga gap open (pengecualian tunggal, 30 Sep 2026)",
            });
          } else if (filled && fill.kind !== "NORMAL") {
            // Overrun besar tapi level SL ternyata DIPERDAGANGKAN (atau tak terbantahkan) —
            // ini gap observasi supervisor, bukan gap pasar: fill tetap di harga SL.
            await this.repo.logEvent("SL_OBSERVATION_GAP_FILL", pos.symbol, {
              positionId: pos.id, slPrice: pos.slPrice, marketPrice: price, fillPrice: fill.price,
              overrunR: Number(fill.overrunR.toFixed(2)), kind: fill.kind,
              note: "Overrun > ambang tapi kline menunjukkan level SL diperdagangkan (gap observasi, bukan gap pasar): fill di harga SL sesuai aturan 30 Sep 2026",
            });
          }
          results.push({ positionId: pos.id, symbol: pos.symbol, action: filled ? "SL" : "NONE", price,
            reason: fill.gap
              ? `Stop loss hit — GAP EXCEPTION terverifikasi kline, fill di harga gap ${fill.price} (overrun ${fill.overrunR.toFixed(2)}R di luar SL)`
              : fill.kind === "NORMAL"
                ? `Stop loss hit — fill di harga SL ${fill.price}`
                : `Stop loss hit — overrun ${fill.overrunR.toFixed(2)}R adalah gap observasi (${fill.kind}); fill tetap di harga SL ${fill.price}` });
          return;
        }
        // SWING RR23: TP1 50% → SL→BE → TP2/final 50% @3R.
        // Legacy SWING tanpa marker tetap 40/30/TPMAX; SCALP single-target.
        const ladder = isLadderPosition(pos);
        const levels = swingLadderLevels(pos);
        const orig = pos.originalQty ?? pos.qty;
        const step = pos.quantityStep && pos.quantityStep > 0 ? pos.quantityStep : 1e-8;
        const stepEps = Math.min(step, 1e-6) * 0.5;
        const done = this.ledgerPhaseDone(pos);
        // 16 Okt 2026 (fix pembulatan #3177): target fase ikut diperBULATKAN ke
        // step (konsisten dengan executeExitLocked). Residu pembulatan tidak
        // boleh membuat trigger TP1 terus-menerus menelan tick setelah fase-nya
        // penuh — itu memblokir TP2/TPmax di rantaian else-if (runner mati).
        const roundPhase = (frac: number) => Math.floor(orig * frac / step + 1e-9) * step;
        const rr23 = usesSwingRr23(pos);
        const tp1Phase = ladder ? roundPhase(rr23 ? SWING_RR23.tp1Frac : SWING_TP1_FRAC) : orig;
        const tp1Target = ladder && tp1Phase < step ? orig : tp1Phase;
        // RR23 has no TPMAX runner: the remainder after TP1 is the final 3R leg.
        const tp2Phase = rr23 ? Math.max(0, orig - tp1Target) : roundPhase(SWING_TP2_FRAC);
        const tp2Target = tp2Phase < step ? (rr23 ? Math.max(0, orig - tp1Target) : orig) : tp2Phase;
        const tpMax = swingTpMaxPrice(pos);
        const atLevel = (level: number) => (long ? price >= level : price <= level);
        // Completed PAPER history was replayed above. These branches handle
        // only the latest mark, with separate candle confirmation for LIMIT TP.
        const paperPos = String(pos.source ?? "").startsWith("PAPER");
        const tp1MarkAt = atLevel(pos.tp1Price);
        if (tp1MarkAt && done.tp1 < tp1Target - stepEps) {
          // TAHAP 5 audit (15 Okt 2026): exit TP PAPER wajib konfirmasi kline
          // (gaya resolveSlFill) — mark price menyentuh TP belum cukup; kline 1m
          // harus membuktikan level TP benar-benar diperdagangkan. Belum
          // terkonfirmasi = tunggu tick berikutnya (posisi tetap open).
          if (env.PAPER_TOUCH_VERIFY && paperPos && !(await this.tpTouchConfirmed(pos, long, pos.tp1Price))) {
            results.push({ positionId: pos.id, symbol: pos.symbol, action: "NONE", price,
              reason: "TP1_WAIT_KLINE_TOUCH: mark menyentuh TP, menunggu konfirmasi kline 1m" });
            return;
          }
          const filled = await this.executeExitLocked(pos, pos.tp1Price, "TP1");
          results.push({ positionId: pos.id, symbol: pos.symbol, action: filled ? "TP1" : "NONE", price });
          // Tahap 7: tanpa non-null assertion — posisi bisa sudah CLOSED; bila
          // baris hilang, bar terakhir cukup memakai snapshot lama.
          const refreshed = await this.repo.findById(pos.id);
          if (refreshed) pos = refreshed;
          if (usesSwingRr23(pos)) {
            await this.retryBreakeven(pos);
            pos = await this.repo.findById(pos.id) ?? pos;
          }
        } else if (ladder && done.tp2 < tp2Target - stepEps && atLevel(levels.tp2)) {
          if (env.PAPER_TOUCH_VERIFY && paperPos && !(await this.tpTouchConfirmed(pos, long, levels.tp2))) {
            results.push({ positionId: pos.id, symbol: pos.symbol, action: "NONE", price,
              reason: "TP2_WAIT_KLINE_TOUCH: mark menyentuh TP2, menunggu konfirmasi kline 1m" });
            return;
          }
          const filled = await this.executeExitLocked(pos, levels.tp2, "TP2");
          const afterTp2 = await this.repo.findById(pos.id);
          if (filled && afterTp2?.status === "OPEN" && this.ledgerPhaseDone(afterTp2).tp2 >= tp2Target - stepEps) {
            pos = afterTp2;
            // A partial TP2 is not the 30% milestone. For a real position the
            // exchange replacement must also succeed before DB claims BE.
            await this.retryBreakeven(pos);
          }
          results.push({ positionId: pos.id, symbol: pos.symbol, action: filled ? "TP2" : "NONE", price });
          const refreshed = await this.repo.findById(pos.id);
          if (refreshed) pos = refreshed;
        } else if (ladder && done.tp2 >= tp2Target - stepEps && atLevel(tpMax)) {
          if (env.PAPER_TOUCH_VERIFY && paperPos && !(await this.tpTouchConfirmed(pos, long, tpMax))) {
            results.push({ positionId: pos.id, symbol: pos.symbol, action: "NONE", price,
              reason: "TPMAX_WAIT_KLINE_TOUCH: mark menyentuh TPmax, menunggu konfirmasi kline 1m" });
            return;
          }
          const filled = await this.executeExitLocked(pos, tpMax, "TPMAX");
          results.push({ positionId: pos.id, symbol: pos.symbol, action: filled ? "TPMAX" : "NONE", price });
          const refreshed = await this.repo.findById(pos.id);
          if (refreshed) pos = refreshed;
        }
        if (!results.some((r) => r.positionId === pos.id)) results.push({ positionId: pos.id, symbol: pos.symbol, action: "NONE", price });
      });
    }
    return results;
  }

  /**
   * Harga eksekusi SL — perintah operator 30 Sep 2026 ("SL nya malah jadi melebar ... gw ga mau
   * ada kesalahan lagi seperti ini, terkecuali da fake out yang luar biasa") + fix 9 Okt 2026
   * (kasus JCTUSDT #2760: supervisor tertidur ~10 mnt di dalam step lock yang stall; saat bangun,
   * overrun 5.81R salah dianggap gap pasar dan posisi ter-fill -6.81R padahal kline 1m menunjukkan
   * harga memperdagangkan SETIAP level di antaranya — gap observasi, bukan gap pasar).
   *
   * - Normal (overrun ≤ SL_GAP_OVERRUN_R × risk distance): fill DI HARGA SL. Loss terkunci ~-1R
   *   berapa pun jauhnya harga sudah jatuh saat monitor mendeteksi; stop-market yang resting di
   *   bursa memicu saat level disentuh (keterlambatan sampling monitor ≠ realita pasar).
   * - Overrun besar TIDAK lagi otomatis dianggap gap pasar. Verifier kline 1m memutuskan:
   *   * TRUE_GAP — bar pertama yang melewati SL TERBUKA sudah melewati level (level SL tidak
   *     pernah diperdagangkan): fill di harga gap open (stop nyata pun ter-slippage ke open).
   *   * SL_FILL — ada bar yang memperdagangkan level SL: gap observasi supervisor; fill di SL.
   *   * UNKNOWN — kline tak tersedia: fail-closed ke aturan dasar (fill di harga SL).
   *   Tanpa verifier terpasang (konstruk lama): perilaku legacy (fill pasar saat overrun).
   */
  /**
   * TAHAP 5 audit (15 Okt 2026): konfirmasi kline utk exit TP paper.
   * LONG: high kline >= tp; SHORT: low kline <= tp. Kline gagal/tak tersedia =
   * TIDAK terkonfirmasi (fail-closed, tunggu tick berikutnya) — bukan fabricate fill.
   */
  private async tpTouchConfirmed(pos: PositionRow, long: boolean, level: number): Promise<boolean> {
    try {
      const rows = await binanceFuturesClient.fetchKlines(pos.symbol, "1m", 5);
      if (!Array.isArray(rows) || rows.length === 0) return false;
      const opened = pos.openedAt.getTime();
      return rows.some((raw) => {
        if (!Array.isArray(raw)) return false;
        const t = Number(raw[0]), h = Number(raw[2]), l = Number(raw[3]);
        return [t, h, l].every(Number.isFinite) && t >= opened
          && (long ? h >= level : l <= level);
      });
    } catch { return false; }
  }

  /** TP2 completion and BE replacement are separate, retryable transitions. */
  private async retryBreakeven(pos: PositionRow): Promise<void> {
    if (pos.status !== "OPEN" || !isLadderPosition(pos) || pos.slPrice === pos.entryPrice) return;
    const step = pos.quantityStep && pos.quantityStep > 0 ? pos.quantityStep : 1e-8;
    const rr23 = usesSwingRr23(pos);
    const target = Math.floor((pos.originalQty ?? pos.qty) * (rr23 ? SWING_RR23.tp1Frac : SWING_TP2_FRAC) / step + 1e-9) * step;
    const done = this.ledgerPhaseDone(pos);
    if (target < step || (rr23 ? done.tp1 : done.tp2) < target - 1e-10) return;
    try {
      // Legacy keeps the historical hook contract; RR23 only calls the
      // exchange replacement hook for LIVE. PAPER RR23 must not replace orders.
      if (this.beMoveHook && (!rr23 || String(pos.source ?? "").startsWith("LIVE_"))) {
        await this.beMoveHook(this.refreshedAfterBe(pos));
      }
      await this.repo.updatePosition(pos.id, { slPrice: pos.entryPrice });
      await this.repo.logEvent("SL_MOVED_BE", pos.symbol, { positionId: pos.id, bePrice: pos.entryPrice });
    } catch (err) {
      await this.repo.logEvent("SL_MOVED_BE_LIVE_FAILED", pos.symbol, {
        positionId: pos.id, error: (err as Error).message,
      });
    }
  }

  /** Replay completed, contiguous post-entry candles. SL wins an ambiguous
   * candle; TP legs may cascade, with BE effective on the following candle.
   * The cursor lives in the existing accounting JSON so restart cannot replay
   * old lows against a stop that was subsequently moved to breakeven. */
  private async replayPaperCandles(initial: PositionRow, now: number): Promise<{ position: PositionRow; results: SupervisorEvaluation[] }> {
    let pos = initial;
    const results: SupervisorEvaluation[] = [];
    let ledger: { orders: Record<string, unknown>; paperCandleCursorMs?: number };
    try { ledger = pos.exitAccounting ? JSON.parse(pos.exitAccounting) : { orders: {} }; }
    catch { return { position: pos, results }; }
    if (!ledger || !ledger.orders || typeof ledger.orders !== "object") return { position: pos, results };
    const opened = pos.openedAt.getTime();
    if (!Number.isFinite(opened) || !Number.isFinite(now)) return { position: pos, results };
    // Existing fills without a cursor cannot safely be reinterpreted under the
    // current phase/stop. Start recovery at the next complete minute instead.
    let cursor = ledger.paperCandleCursorMs ?? Math.ceil(
      (Object.keys(ledger.orders).length ? now : opened) / 60_000) * 60_000;
    if (!Number.isFinite(cursor) || cursor < opened) return { position: pos, results };
    if (cursor + 60_000 > now) return { position: pos, results };
    let rows: unknown[];
    try { rows = await binanceFuturesClient.fetchKlines(pos.symbol, "1m",
      Math.min(1500, Math.max(2, Math.ceil((now - cursor) / 60_000) + 2))); }
    catch { return { position: pos, results }; }
    if (!Array.isArray(rows)) return { position: pos, results };
    // Persist before any order intent/fill, including a pending or partial TP.
    // Otherwise restart could mistake that new leg for a legacy ledger and
    // skip the candle that still needs settlement.
    if (ledger.paperCandleCursorMs === undefined) {
      pos = await this.repo.updatePosition(pos.id, {
        exitAccounting: JSON.stringify({ ...ledger, paperCandleCursorMs: cursor }),
      });
    }
    const candles = rows.filter(Array.isArray).map(raw => ({
      time: Number(raw[0]), open: Number(raw[1]), high: Number(raw[2]), low: Number(raw[3]), close: Number(raw[4]),
    })).filter(b => Object.values(b).every(Number.isFinite) && b.time >= cursor && b.time + 60_000 <= now
      && b.time % 60_000 === 0 && b.low > 0 && b.high >= Math.max(b.open, b.close, b.low)
      && b.low <= Math.min(b.open, b.close)).sort((a, b) => a.time - b.time);
    const long = pos.side === "LONG";
    for (const candle of candles) {
      if (candle.time !== cursor) break; // Missing bars are unknown, never skip straight to a later TP.
      if (long ? candle.low <= pos.slPrice : candle.high >= pos.slPrice) {
        const fill = long ? Math.min(pos.slPrice, candle.open) : Math.max(pos.slPrice, candle.open);
        const filled = await this.executeExitLocked(pos, fill, "SL");
        pos = await this.repo.findById(pos.id) ?? pos;
        results.push({ positionId: pos.id, symbol: pos.symbol, action: filled ? "SL" : "NONE", price: fill,
          reason: "PAPER_CHRONOLOGICAL_STOP_FIRST" });
        return { position: pos, results };
      }
      const ladder = isLadderPosition(pos);
      const levels = swingLadderLevels(pos);
      const step = pos.quantityStep && pos.quantityStep > 0 ? pos.quantityStep : 1e-8;
      const original = pos.originalQty ?? pos.qty;
      const target = (frac: number) => {
        const rounded = Math.floor(original * frac / step + 1e-9) * step;
        return rounded < step ? original : rounded;
      };
      for (const phase of ["TP1", "TP2", "TPMAX"] as const) {
        if (phase !== "TP1" && !ladder) break;
        const done = this.ledgerPhaseDone(pos);
        const rr23 = usesSwingRr23(pos);
        const tp1Required = ladder ? target(rr23 ? SWING_RR23.tp1Frac : SWING_TP1_FRAC) : original;
        const required = phase === "TP1" ? tp1Required
          : phase === "TP2" ? (rr23 ? Math.max(0, original - tp1Required) : target(SWING_TP2_FRAC)) : pos.qty;
        if (phase !== "TPMAX" && (phase === "TP1" ? done.tp1 : done.tp2) >= required - 1e-10) continue;
        const level = phase === "TP1" ? pos.tp1Price : phase === "TP2" ? levels.tp2 : swingTpMaxPrice(pos);
        if (!(long ? candle.high >= level : candle.low <= level)) break;
        const filled = await this.executeExitLocked(pos, level, phase);
        pos = await this.repo.findById(pos.id) ?? pos;
        results.push({ positionId: pos.id, symbol: pos.symbol, action: filled ? phase : "NONE", price: level });
        if (pos.status !== "OPEN") return { position: pos, results };
        const after = this.ledgerPhaseDone(pos);
        if (phase === "TPMAX" || (phase === "TP1" ? after.tp1 : after.tp2) < required - 1e-10)
          return { position: pos, results }; // Preserve pending/partial accounting for retry.
      }
      await this.retryBreakeven(pos);
      pos = await this.repo.findById(pos.id) ?? pos;
      cursor += 60_000;
      const latest = pos.exitAccounting ? JSON.parse(pos.exitAccounting) : { orders: {} };
      pos = await this.repo.updatePosition(pos.id, { exitAccounting: JSON.stringify({ ...latest, paperCandleCursorMs: cursor }) });
    }
    return { position: pos, results };
  }

  /** Total qty terisi per fase TP dari ledger exitAccounting (sumber kebenaran fill). */
  private ledgerPhaseDone(pos: PositionRow): { tp1: number; tp2: number; tpMax: number } {
    const out = { tp1: 0, tp2: 0, tpMax: 0 };
    if (!pos.exitAccounting) return out;
    try {
      const ledger = JSON.parse(pos.exitAccounting) as { orders?: Record<string, { phase?: string; qty?: number }> };
      for (const leg of Object.values(ledger.orders ?? {})) {
        const q = Number(leg?.qty) || 0;
        if (leg?.phase === "TP1") out.tp1 += q;
        else if (leg?.phase === "TP2") out.tp2 += q;
        else if (leg?.phase === "TPMAX") out.tpMax += q;
      }
    } catch { /* ledger invalid -> anggap 0 (executeExitLocked akan gagal-closed sendiri) */ }
    return out;
  }

  private async resolveSlFill(
    pos: PositionRow,
    marketPrice: number,
    nowMs: number
  ): Promise<{ price: number; gap: boolean; overrunR: number; kind: "NORMAL" | "TRUE_GAP" | "OBSERVATION_GAP" | "GAP_UNVERIFIED" | "LEGACY_NO_VERIFIER" }> {
    const long = pos.side === "LONG";
    const riskDistance = Math.abs(pos.entryPrice - pos.slPrice);
    const overrun = long ? pos.slPrice - marketPrice : marketPrice - pos.slPrice;
    const overrunR = riskDistance > 0 ? Math.max(0, overrun) / riskDistance : Number.POSITIVE_INFINITY;
    if (overrunR <= env.SL_GAP_OVERRUN_R) return { price: pos.slPrice, gap: false, overrunR, kind: "NORMAL" };
    if (!this.gapVerifier) return { price: marketPrice, gap: true, overrunR, kind: "LEGACY_NO_VERIFIER" };
    let verdict: SlGapVerdict = { kind: "UNKNOWN" };
    try { verdict = await this.gapVerifier(pos.symbol, String(pos.side), pos.slPrice, nowMs); } catch { /* fail-closed */ }
    if (verdict.kind === "TRUE_GAP" && Number.isFinite(verdict.gapOpenPrice) && verdict.gapOpenPrice > 0) {
      return { price: verdict.gapOpenPrice, gap: true, overrunR, kind: "TRUE_GAP" };
    }
    return { price: pos.slPrice, gap: false, overrunR, kind: verdict.kind === "SL_FILL" ? "OBSERVATION_GAP" : "GAP_UNVERIFIED" };
  }

  private async withPosition<T>(id: number, action: (pos: PositionRow) => Promise<T>): Promise<T | undefined> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(async () => {
      const current = await this.repo.findById(id);
      if (!current || current.status !== "OPEN") return undefined;
      return action(current);
    });
    this.locks.set(id, task);
    try { return await task; } finally { if (this.locks.get(id) === task) this.locks.delete(id); }
  }

  /**
   * Evaluasi funding countdown (FR-19: funding <= 10 menit).
   * 30 Sep 2026 — refactor SCALP-only: filter mode dihapus. Funding check
   * berlaku untuk semua posisi terbuka (mode dibaca apa adanya dari DB).
   */
  async evaluateFunding(funding: FundingInfo, currentPrice: number): Promise<SupervisorEvaluation[]> {
    // DIMATIKAN di produksi (fundingExitEnabled:false) — iuran funding dibiarkan
    // dipotong otomatis oleh Binance. Fungsi dipertahankan untuk unit test.
    if (!this.fundingExitEnabled) return [];
    const openPositions = await this.repo.findOpenPositions(funding.symbol);
    const results: SupervisorEvaluation[] = [];
    const currentTime = this.now();
    const msToFunding = funding.nextFundingTime - currentTime;

    if (msToFunding > 0 && msToFunding <= 10 * 60 * 1000) {
      for (const pos of openPositions) {
        const isAdverse =
          (pos.side === "LONG" && funding.fundingRate > 0) ||
          (pos.side === "SHORT" && funding.fundingRate < 0);

        if (isAdverse) {
          await this.handleFundingExit(pos, currentPrice, funding.fundingRate);
          results.push({
            positionId: pos.id,
            symbol: pos.symbol,
            action: "FUNDING",
            price: currentPrice,
            reason: `Adverse funding ${funding.fundingRate} with ${Math.round(msToFunding / 1000)}s left`,
          });
        }
      }
    }

    return results;
  }

  async emergencyKill(positionId: number, currentPrice: number, reason: CloseReason = "KILL"): Promise<void> {
    await this.withPosition(positionId, (pos) => this.executeExitLocked(pos, currentPrice, reason));
  }

  async exitOnTrendFlip(positionId: number, currentPrice: number, trendInfo: Record<string, unknown>): Promise<boolean> {
    const position = await this.repo.findById(positionId);
    const completed = await this.withPosition(positionId, (pos) => this.executeExitLocked(pos, currentPrice, "TREND_FLIP"));
    if (completed) {
      await this.repo.logEvent("TREND_FLIP_EXIT", "", { positionId, ...trendInfo });
      // Catat kunci arah-yang-sama (in-memory, tahan restart lewat seed saat boot):
      // re-entry dengan ARAH YANG SAMA diblokir selama TREND_FLIP_SIDE_COOLDOWN_MS.
      if (position) {
        trendFlipSideCooldown.record(position.symbol, position.side);
      }
    }
    return completed ?? false;
  }

  private async handleFundingExit(pos: PositionRow, price: number, _rate: number): Promise<void> {
    await this.withPosition(pos.id, (current) => this.executeExitLocked(current, price, "FUNDING"));
  }

  /** Persist cumulative exchange fills per deterministic order id. Applying a retry
   * is a replacement of cumulative numbers, never another debit of quantity. */
  private async executeExitLocked(pos: PositionRow, price: number, reason: CloseReason): Promise<boolean> {
    if (!(Number.isFinite(price) && price > 0)) return false;
    type Leg = { phase: CloseReason; requestedQty: number; qty: number; notional: number; fee: number; status: string; simulated?: boolean; estimated?: boolean };
    type Ledger = { orders: Record<string, Leg>; legacyQty?: number; legacyNotional?: number; legacyRealized?: number };
    let ledger: Ledger;
    try { ledger = pos.exitAccounting ? JSON.parse(pos.exitAccounting) : { orders: {} }; }
    catch { await this.repo.logEvent("EXIT_ACCOUNTING_INVALID", pos.symbol, { positionId: pos.id }); return false; }
    if (!ledger || typeof ledger.orders !== "object" || !ledger.orders) return false;
    const originalQty = pos.originalQty ?? pos.qty;
    const originalSl = pos.originalSlPrice ?? pos.slPrice;
    const risk = pos.originalRiskUsd ?? Math.abs(pos.entryPrice - originalSl) * originalQty;
    if (!(originalQty > 0) || !(risk > 0)) return false;
    const step = pos.quantityStep && pos.quantityStep > 0 ? pos.quantityStep : 1e-8;
    const roundQty = (q: number) => Number(Math.max(0, q).toFixed(12));
    const floorQty = (q: number) => roundQty(Math.floor(q / step + 1e-9) * step);
    const entries = Object.entries(ledger.orders);
    let active = entries.find(([, leg]) => ["NEW", "PARTIAL"].includes(leg.status));
    const executor = this.executorForPosition?.(pos) ?? this.executor;
    let settledExecution: ExecutionResult | undefined;
    let followupReason: CloseReason | undefined;
    if (active && active[1].phase !== reason) {
      // SL/KILL may supersede a resting TP only after its terminal state and all
      // racing fills are known. Apply those cumulative fills before closing the
      // remaining quantity; never silently turn a stop into another TP retry.
      const cancellation: OrderCancellationResult = typeof executor.cancelEntry === "function"
        ? await executor.cancelEntry(pos.symbol, active[0]).catch(() => ({ confirmed: false }))
        : { confirmed: false };
      if (!cancellation.confirmed || !cancellation.execution) {
        await this.repo.logEvent("EXIT_WAITING_RECONCILIATION", pos.symbol, { positionId: pos.id, clientOrderId: active[0], requestedPhase: reason });
        return false;
      }
      settledExecution = cancellation.execution;
      followupReason = reason;
      reason = active[1].phase;
    }
    // SWING RR23: TP1 = 50% qty awal @2R; TP2 = seluruh sisa @3R (tanpa runner).
    // Legacy SWING tanpa marker tetap 40/30/TPMAX. SCALP: TP1 menutup 100%.
    const ladder = isLadderPosition(pos);
    const doneNow = this.ledgerPhaseDone(pos);
    let target: number;
    if (reason === "TP1" && ladder) {
      // 16 Okt 2026 (fix pembulatan #3177): target fase DIPERBULATKAN ke step,
      // konsisten dengan trigger. Residu pembulatan (mis. 40% x 41.2 = 16.48 →
      // floor 16.4, sisa 0.08 < step) adalah fase YANG SUDAH PENUH — menghitung
      // residu sebagai "target < step" lalu degradasi full-close akan mematikan
      // runner ladder lebih awal (salah tutup 100% di TP1).
      const phaseTarget = Math.floor(originalQty * (usesSwingRr23(pos) ? SWING_RR23.tp1Frac : SWING_TP1_FRAC) / step + 1e-9) * step;
      if (phaseTarget < step) target = originalQty; // fase 40% tak muat 1 step: degradasi full-close (no zero-size runner)
      else {
        target = phaseTarget - doneNow.tp1;
        if (target < step) return false; // fase penuh; sisa hanya residu pembulatan
      }
    } else if (reason === "TP2") {
      // RR23: TP2 is the final 3R leg and must consume every remaining lot
      // after the confirmed TP1 milestone (including step-rounding residue).
      const rr23 = usesSwingRr23(pos);
      const phaseTarget = rr23
        ? Math.max(0, originalQty - doneNow.tp1)
        : Math.floor(originalQty * SWING_TP2_FRAC / step + 1e-9) * step;
      if (phaseTarget < step) target = rr23 ? phaseTarget : originalQty;
      else {
        target = phaseTarget - doneNow.tp2;
        if (target < step) return false;
      }
    } else {
      target = originalQty; // TP1 non-ladder (single target) / SL/FUNDING/KILL/TREND_FLIP/LIQ_GAP/TPMAX = sisa penuh
    }
    const tp1Done = entries.filter(([, leg]) => leg.phase === "TP1").reduce((sum, [, leg]) => sum + leg.qty, 0);
    const requestedQty = active?.[1].requestedQty
      ?? (reason === "TP1" || reason === "TP2"
        ? Math.min(pos.qty, roundQty(Math.max(0, target)))
        : pos.qty);
    if (!(requestedQty > 0)) return false;
    const attempts = entries.filter(([, leg]) => leg.phase === reason).length;
    // Include stable position identity and sizing in the id. Test fixtures and
    // repaired databases can reuse numeric ids/open timestamps; omitting the
    // symbol/entry basis would make two unrelated exits collide in the ledger.
    const idBasis = `${pos.id}_${pos.openedAt.getTime().toString(36)}_${pos.symbol}_${pos.side}_${pos.entryPrice}_${originalQty}`
      .replace(/[^A-Za-z0-9]/g, "").slice(0, 25);
    const id = active?.[0] ?? `PX_${idBasis}_${reason}_${attempts}`.slice(0, 36);
    // 15 Okt 2026: semua fase TP dieksekusi LIMIT di levelnya masing-masing
    // (TP1 -> tp1Price, TP2 -> tp2Price, TPMAX -> tpMax turunan R×5); exit
    // lain (SL/gap/kill) tetap MARKET di harga terdeteksi.
    const limitPrice = reason === "TP1" ? pos.tp1Price
      : reason === "TP2" ? swingLadderLevels(pos).tp2
      : reason === "TPMAX" ? swingTpMaxPrice(pos)
      : NaN;
    const type = Number.isFinite(limitPrice) ? "LIMIT" : "MARKET";
    // The intent is durable before submitting. A crash retries/query-reconciles id.
    if (!active) {
      ledger.orders[id] = { phase: reason, requestedQty, qty: 0, notional: 0, fee: 0, status: "NEW" };
      pos = await this.repo.updatePosition(pos.id, {
        originalQty, originalSlPrice: originalSl, originalRiskUsd: risk,
        exitAccounting: JSON.stringify(ledger),
      });
    }
    const result = settledExecution ?? await executor.executeOrder({ clientOrderId: id, symbol: pos.symbol,
      side: pos.side === "LONG" ? "SELL" : "BUY", type,
      price: Number.isFinite(limitPrice) ? limitPrice : price,
      qty: requestedQty, reduceOnly: true, positionId: pos.id,
      // 16 Okt 2026 (fix lanjutan #3177): exit TP paper LIMIT = bracket yang
      // seharusnya resting sejak posisi dibuka. Bukti sentuhan dihitung sejak
      // openedAt — penempatan order yang telat tidak boleh menghapus hak fill
      // dari sentuhan level yang lebih awal (kebijakan "TP resting PASTI terisi
      // bila level diperdagangkan kapan pun sejak posisi dibuka").
      ...(type === "LIMIT"
        ? { touchSinceMs: pos.openedAt instanceof Date ? pos.openedAt.getTime() : Number(pos.openedAt) }
        : {}) });
    const previous = ledger.orders[id]!;
    const confirmedQty = Number(result.filledQty);
    if (!Number.isFinite(confirmedQty) || confirmedQty < previous.qty - 1e-10 || confirmedQty > requestedQty + 1e-10 ||
        (confirmedQty > 0 && !(result.fillPrice && Number.isFinite(result.fillPrice) && result.fillPrice > 0))) {
      await this.repo.logEvent("EXIT_FILL_INVALID", pos.symbol, { positionId: pos.id, clientOrderId: id });
      return false;
    }
    ledger.orders[id] = { ...previous, qty: confirmedQty, notional: confirmedQty * (result.fillPrice ?? 0),
      fee: result.feeUsd, status: result.status, simulated: result.simulated, estimated: result.feeEstimated ?? true };
    const legs = Object.values(ledger.orders);
    const exitedQty = (ledger.legacyQty ?? 0) + legs.reduce((n, leg) => n + leg.qty, 0);
    const remaining = roundQty(originalQty - exitedQty);
    const exitNotional = legs.reduce((n, leg) => n + leg.notional, 0);
    const exitFees = legs.reduce((n, leg) => n + leg.fee, 0);
    const newQty = legs.reduce((n, leg) => n + leg.qty, 0);
    // Fee penuh (18 Okt 2026) — menggantikan "Perintah Operator: Hapus Fee &
    // Slippage. PnL murni Gross Price Difference" (dicabut). entryFee dari
    // plannedEntry (taker), exitFees dari tiap leg (TP limit = maker, SL = taker).
    // Konvensi DB (lihat config/costs.ts): pnlUsd = NET; rMultiple tetap R basis
    // jarak harga GROSS supaya ladder 2R/3R tetap berlaku.
    const entryFeeRaw = Number(pos.entryFeeUsd ?? 0);
    const entryFee = Number.isFinite(entryFeeRaw) && entryFeeRaw > 0 ? entryFeeRaw : 0;
    const grossRealized = (ledger.legacyRealized ?? 0) + (pos.side === "LONG" ? 1 : -1) * (exitNotional - pos.entryPrice * newQty);
    // Entry fee (sunk cost saat entry) diatribusikan proporsional thd qty yang sudah
    // keluar: 0 bila belum ada exit (mis. TP1 ditolak), penuh saat close penuh.
    const entryFeeShare = originalQty > 0 ? entryFee * Math.min(1, exitedQty / originalQty) : entryFee;
    const totalFees = entryFeeShare + exitFees;
    const realized = Number((grossRealized - totalFees).toFixed(6)); // NET (fee sudah termasuk)
    const tp1Qty = legs.filter((leg) => leg.phase === "TP1").reduce((n, leg) => n + leg.qty, 0);
    const tp1TargetEff = ladder ? Math.floor(originalQty * (usesSwingRr23(pos) ? SWING_RR23.tp1Frac : SWING_TP1_FRAC) / step + 1e-9) * step : originalQty;
    const tp1Complete = tp1Qty >= tp1TargetEff - 1e-10;
    const patch: Partial<PositionRow> = { exitAccounting: JSON.stringify(ledger), qty: remaining,
      notional: remaining * pos.entryPrice, marginUsd: remaining * pos.entryPrice / pos.leverage,
      realizedPnlUsd: realized };
    if (tp1Complete && remaining > 0) {
      // Fase TP1 selesai (RR23 50% / legacy 40% / single-target 100%):
      // tandai tp1FilledAt supaya gate TP2/TPmax tahu fase pertama sudah bank.
      patch.tp1FilledAt = pos.tp1FilledAt ?? new Date(this.now());
      patch.tp1FillPrice = legs.filter((leg) => leg.phase === "TP1").reduce((n, leg) => n + leg.notional, 0) / tp1Qty;
    }
    if (remaining > 1e-10) {
      const updated = await this.repo.updatePosition(pos.id, patch);
      await this.repo.logEvent(confirmedQty > previous.qty ? "EXIT_FILL_APPLIED" : "EXIT_NOT_FILLED", pos.symbol,
        { positionId: pos.id, clientOrderId: id, status: result.status, filledQty: confirmedQty, remainingQty: remaining });
      if (followupReason) return this.executeExitLocked(updated, price, followupReason);
      return confirmedQty > previous.qty;
    }
    const now = new Date(this.now());
    // R basis jarak harga (GROSS) — bukan net — supaya makna 2R/3R pada ladder tetap.
    const rMultiple = risk > 0 ? grossRealized / risk : 0;
    const directional = pos.side === "LONG" ? 1 : -1;
    const riskDistance = risk / originalQty;
    const fullBasis = pos.accountingVersion === 1;
    const simulated = legs.every((leg) => leg.simulated);
    const trade: TradeRow = { positionId: pos.id, symbol: pos.symbol, mode: pos.mode, side: pos.side,
      riskUsd: risk, riskBudgetUsd: pos.riskBudgetUsd ?? null,
      entryAvg: pos.entryPrice, exitAvg: (exitNotional + (ledger.legacyNotional ?? 0)) / originalQty,
      rMultiple, pnlUsd: realized, feeUsd: totalFees,
      // Zero is a placeholder until an exchange funding ledger is integrated.
      fundingUsd: 0, fundingVerified: false,
      win: realized > 0, mfeR: Math.max(0, directional * ((pos.mfePrice ?? pos.entryPrice) - pos.entryPrice) / riskDistance),
      maeR: Math.max(0, -directional * ((pos.maePrice ?? pos.entryPrice) - pos.entryPrice) / riskDistance),
      excursionsVerified: fullBasis && pos.mfePrice != null && pos.maePrice != null,
      accountingQuality: !fullBasis ? "LEGACY" : simulated ? "SIMULATED" : "ESTIMATED",
      holdMinutes: Math.max(0, Math.round((this.now() - pos.openedAt.getTime()) / 60000)), createdAt: now,
      strategyId: pos.strategyId ?? null, zoneType: pos.zoneType ?? null, source: pos.source ?? "LEGACY",
      entryAttrs: pos.entryAttrs ?? null };
    Object.assign(patch, { status: "CLOSED", closedAt: now, closeReason: reason, pnlUsd: realized, pnlR: rMultiple });
    if (this.repo.closePositionWithTrade) await this.repo.closePositionWithTrade(pos.id, patch, trade);
    else { await this.repo.createTrade(trade); await this.repo.updatePosition(pos.id, patch); }
    // Fase 2 (13 Okt): posisi tertutup penuh via executor -> proteksi sibling
    // (SLA_/TPA_) milik trade ini WAJIB dibatalkan + diverifikasi (insiden orphan
    // 3028/3029). Hook dipasang index.ts; fail-open, tidak mengubah hasil exit.
    if (this.fullyClosedHook) {
      await this.fullyClosedHook({ ...pos, ...patch } as PositionRow, reason).catch(() => undefined);
    }
    await recordApprovedRuleOutcomeForTrade(pos.id, rMultiple, { store: prismaPlaybookRuleStore }).catch(() => undefined);
    await updateClosedDirectionBattle(pos.id).catch(() => undefined);
    await this.repo.logEvent("POSITION_CLOSED", pos.symbol, { positionId: pos.id, closeReason: reason, exitAvg: trade.exitAvg, netPnlUsd: realized, rMultiple });
    // Rule circuit breaker: a rule that influenced repeated outcomes can be
    // rolled back immediately; APPROVED is never allowed to remain active after
    // its deterministic friction/drawdown threshold is crossed.
    const ruleEvents = await db.eventLog.findMany({ where: { type: { in: ["RULE_APPLIED", "RULE_FRICTION"] } }, orderBy: { id: "desc" }, take: 100 });
    const influencedRuleIds = new Set(ruleEvents.flatMap((event) => {
      try {
        const payload = JSON.parse(event.payload) as Record<string, unknown>;
        return typeof payload.tradeId === "number" && payload.tradeId === trade.positionId && typeof payload.ruleId === "string" ? [payload.ruleId] : [];
      } catch { return []; }
    }));
    for (const ruleId of influencedRuleIds) await autoRollbackRuleIfNeeded(ruleId, { store: prismaPlaybookRuleStore }).catch(() => undefined);
    return true;
  }
}

export const prismaPositionRepo: PositionRepo = {
  // 27 Okt 2026 (insiden go-live 07:15 WIB): supervisor INTERNAL (mark-price
  // polling) hanya boleh mengelola posisi SIMULASI. Posisi LIVE ditutup oleh
  // SL/TP resting di exchange (livePositionWatcher mencatatnya di DB). Kalau
  // repo ini mengembalikan posisi LIVE_*, supervisor bisa memicu exit yang
  // sama dua kali (SL di exchange + exit supervisor) untuk simbol yang sama.
  // Caller supervisePositions sudah menyaring; filter di sini adalah lapisan
  // kedua yang menutup celah bila ada pemanggil lain.
  async findOpenPositions(symbol?: string): Promise<PositionRow[]> {
    const rows = await db.position.findMany({
      where: {
        status: "OPEN",
        source: { not: { startsWith: "LIVE_" } },
        ...(symbol ? { symbol } : {}),
      },
    });
    return rows as PositionRow[];
  },

  async findById(id: number): Promise<PositionRow | null> {
    const row = await db.position.findUnique({
      where: { id },
    });
    return row as PositionRow | null;
  },

  async createPosition(data: Omit<PositionRow, "id">): Promise<PositionRow> {
    const row = await db.position.create({
      data: {
        originalQty: data.originalQty,
        originalSlPrice: data.originalSlPrice,
        originalRiskUsd: data.originalRiskUsd,
        riskBudgetUsd: data.riskBudgetUsd,
        entryFeeUsd: data.entryFeeUsd,
        entryFeeEstimated: data.entryFeeEstimated,
        quantityStep: data.quantityStep,
        priceTick: data.priceTick,
        mfePrice: data.mfePrice,
        maePrice: data.maePrice,
        accountingVersion: data.accountingVersion,
        exitAccounting: data.exitAccounting,
        symbol: data.symbol,
        mode: data.mode,
        side: data.side,
        entryPrice: data.entryPrice,
        qty: data.qty,
        notional: data.notional,
        leverage: data.leverage,
        marginUsd: data.marginUsd,
        slPrice: data.slPrice,
        tp1Price: data.tp1Price,
        // Kolom legacy: tp2Price sekarang dipakai ladder SWING (R×10/3);
        // fallback tp1Price untuk posisi SCALP/legacy tanpa tp2.
        tp2Price: data.tp2Price ?? data.tp1Price,
        status: data.status,
        openedAt: data.openedAt,
        outlookText: data.outlookText ?? "",
        strategyId: data.strategyId ?? null,
        strategyName: data.strategyName ?? null,
        entryType: data.entryType ?? null,
        zoneType: data.zoneType ?? null,
        zoneTop: data.zoneTop ?? null,
        zoneBottom: data.zoneBottom ?? null,
        source: data.source ?? "LIVE_AI",
        entryAttrs: data.entryAttrs ?? null,
      },
    });
    return row as PositionRow;
  },

  async updatePosition(id: number, data: Partial<PositionRow>): Promise<PositionRow> {
    const row = await db.position.update({
      where: { id },
      data: {
        ...(data.originalQty !== undefined ? { originalQty: data.originalQty } : {}),
        ...(data.originalSlPrice !== undefined ? { originalSlPrice: data.originalSlPrice } : {}),
        ...(data.originalRiskUsd !== undefined ? { originalRiskUsd: data.originalRiskUsd } : {}),
        ...(data.riskBudgetUsd !== undefined ? { riskBudgetUsd: data.riskBudgetUsd } : {}),
        ...(data.entryFeeUsd !== undefined ? { entryFeeUsd: data.entryFeeUsd } : {}),
        ...(data.entryFeeEstimated !== undefined ? { entryFeeEstimated: data.entryFeeEstimated } : {}),
        ...(data.quantityStep !== undefined ? { quantityStep: data.quantityStep } : {}),
        ...(data.priceTick !== undefined ? { priceTick: data.priceTick } : {}),
        ...(data.mfePrice !== undefined ? { mfePrice: data.mfePrice } : {}),
        ...(data.maePrice !== undefined ? { maePrice: data.maePrice } : {}),
        ...(data.accountingVersion !== undefined ? { accountingVersion: data.accountingVersion } : {}),
        ...(data.exitAccounting !== undefined ? { exitAccounting: data.exitAccounting } : {}),
        ...(data.symbol !== undefined ? { symbol: data.symbol } : {}),
        ...(data.mode !== undefined ? { mode: data.mode } : {}),
        ...(data.side !== undefined ? { side: data.side } : {}),
        ...(data.entryPrice !== undefined ? { entryPrice: data.entryPrice } : {}),
        ...(data.qty !== undefined ? { qty: data.qty } : {}),
        ...(data.notional !== undefined ? { notional: data.notional } : {}),
        ...(data.leverage !== undefined ? { leverage: data.leverage } : {}),
        ...(data.marginUsd !== undefined ? { marginUsd: data.marginUsd } : {}),
        ...(data.status !== undefined ? { status: data.status } : {}),
        ...(data.slPrice !== undefined ? { slPrice: data.slPrice } : {}),
        ...(data.tp1Price !== undefined ? { tp1Price: data.tp1Price } : {}),
        ...(data.tp1FilledAt !== undefined ? { tp1FilledAt: data.tp1FilledAt } : {}),
        ...(data.realizedPnlUsd !== undefined ? { realizedPnlUsd: data.realizedPnlUsd } : {}),
        ...(data.tp1FillPrice !== undefined ? { tp1FillPrice: data.tp1FillPrice } : {}),
        ...(data.closedAt !== undefined ? { closedAt: data.closedAt } : {}),
        ...(data.closeReason !== undefined ? { closeReason: data.closeReason } : {}),
        ...(data.pnlUsd !== undefined ? { pnlUsd: data.pnlUsd } : {}),
        ...(data.pnlR !== undefined ? { pnlR: data.pnlR } : {}),
        ...(data.outlookText !== undefined ? { outlookText: data.outlookText } : {}),
        ...(data.strategyId !== undefined ? { strategyId: data.strategyId } : {}),
        ...(data.strategyName !== undefined ? { strategyName: data.strategyName } : {}),
        ...(data.entryType !== undefined ? { entryType: data.entryType } : {}),
        ...(data.zoneType !== undefined ? { zoneType: data.zoneType } : {}),
        ...(data.zoneTop !== undefined ? { zoneTop: data.zoneTop } : {}),
        ...(data.zoneBottom !== undefined ? { zoneBottom: data.zoneBottom } : {}),
        ...(data.source !== undefined && data.source !== null ? { source: data.source } : {}),
      },
    });
    return row as PositionRow;
  },

  async createTrade(data: TradeRow): Promise<TradeRow> {
    const row = await db.trade.create({
      data: {
        positionId: data.positionId,
        symbol: data.symbol,
        mode: data.mode,
        side: data.side,
        accountingQuality: data.accountingQuality,
        fundingVerified: data.fundingVerified,
        excursionsVerified: data.excursionsVerified,
        riskUsd: data.riskUsd,
        riskBudgetUsd: data.riskBudgetUsd ?? null,
        entryAvg: data.entryAvg,
        exitAvg: data.exitAvg,
        rMultiple: data.rMultiple,
        pnlUsd: data.pnlUsd,
        feeUsd: data.feeUsd,
        fundingUsd: data.fundingUsd,
        win: data.win,
        mfeR: data.mfeR,
        maeR: data.maeR,
        holdMinutes: data.holdMinutes,
        createdAt: data.createdAt ?? new Date(),
        strategyId: data.strategyId ?? null,
        zoneType: data.zoneType ?? null,
        source: data.source ?? "LIVE_AI",
        entryAttrs: data.entryAttrs ?? null,
      },
    });
    return row as TradeRow;
  },

  // Atomik: Position CLOSED + Trade insert dalam 1 transaksi Prisma.
  // Dipakai finalizePosition supaya tidak ada lagi posisi CLOSED tanpa Trade.
  async closePositionWithTrade(positionId: number, patch: Partial<PositionRow>, trade: TradeRow): Promise<TradeRow> {
    const created = await db.$transaction(async (tx) => {
      const existing = await tx.trade.findUnique({ where: { positionId } });
      if (existing) return existing;
      await tx.position.update({
        where: { id: positionId },
        data: {
          ...(patch.qty !== undefined ? { qty: patch.qty } : {}),
          ...(patch.notional !== undefined ? { notional: patch.notional } : {}),
          ...(patch.marginUsd !== undefined ? { marginUsd: patch.marginUsd } : {}),
          ...(patch.realizedPnlUsd !== undefined ? { realizedPnlUsd: patch.realizedPnlUsd } : {}),
          ...(patch.exitAccounting !== undefined ? { exitAccounting: patch.exitAccounting } : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.closedAt !== undefined ? { closedAt: patch.closedAt } : {}),
          ...(patch.closeReason !== undefined ? { closeReason: patch.closeReason } : {}),
          ...(patch.pnlUsd !== undefined ? { pnlUsd: patch.pnlUsd } : {}),
          ...(patch.pnlR !== undefined ? { pnlR: patch.pnlR } : {}),
        },
      });
      const row = await tx.trade.create({
        data: {
          positionId: trade.positionId,
          symbol: trade.symbol,
          mode: trade.mode,
          side: trade.side,
          accountingQuality: trade.accountingQuality,
          fundingVerified: trade.fundingVerified,
          excursionsVerified: trade.excursionsVerified,
          riskUsd: trade.riskUsd,
          riskBudgetUsd: trade.riskBudgetUsd ?? null,
          entryAvg: trade.entryAvg,
          exitAvg: trade.exitAvg,
          rMultiple: trade.rMultiple,
          pnlUsd: trade.pnlUsd,
          feeUsd: trade.feeUsd,
          fundingUsd: trade.fundingUsd,
          win: trade.win,
          mfeR: trade.mfeR,
          maeR: trade.maeR,
          holdMinutes: trade.holdMinutes,
          createdAt: trade.createdAt ?? new Date(),
          strategyId: trade.strategyId ?? null,
          zoneType: trade.zoneType ?? null,
          source: trade.source ?? "LIVE_AI",
          entryAttrs: trade.entryAttrs ?? null,
        },
      });
      return row;
    });
    return created as TradeRow;
  },

  async logEvent(action: string, symbol: string, payload: Record<string, unknown>): Promise<void> {
    await db.eventLog.create({
      data: {
        type: action,
        severity: "info",
        payload: JSON.stringify({ symbol, ...payload }),
      },
    });
  },
};

// ── Verifier gap SL berbasis kline (fix 9 Okt 2026, kasus JCTUSDT #2760) ──
// Memutuskan apakah overrun besar di luar SL adalah gap pasar sungguhan atau
// sekadar gap observasi supervisor (polling telat karena lock stall).
export type SlGapVerdict =
  | { kind: "SL_FILL" }
  | { kind: "TRUE_GAP"; gapOpenPrice: number }
  | { kind: "UNKNOWN" };

export type SlGapVerifier = (symbol: string, side: string, slPrice: number, nowMs: number) => Promise<SlGapVerdict>;

/**
 * Baca ±20 bar 1m terakhir; bar PERTAMA (urutan waktu naik) yang range-nya mencapai level SL
 * memutuskan:
 * - open masih di sisi posisi (level SL berada di dalam range bar) → harga MEMPERDAGANGKAN
 *   level SL → stop resting pasti terpicu di SL → SL_FILL (gap observasi, bukan gap pasar).
 * - open sudah melewati level SL → gap sungguhan melewati stop → TRUE_GAP di harga open
 *   (fill stop nyata = trade pertama di/pasar level, yaitu open bar tersebut).
 * Baris kline Binance: [openTime, open, high, low, close, volume, ...].
 */
export function createKlineSlGapVerifier(
  fetchKlines?: (symbol: string, interval: string, limit: number) => Promise<unknown[]>
): SlGapVerifier {
  const fetcher = fetchKlines ?? ((symbol, interval, limit) => binanceFuturesClient.fetchKlines(symbol, interval, limit));
  return async (symbol, side, slPrice, _nowMs) => {
    if (!(slPrice > 0)) return { kind: "UNKNOWN" };
    let rows: unknown[] = [];
    try { rows = await fetcher(symbol, "1m", 20); } catch { return { kind: "UNKNOWN" }; }
    if (!Array.isArray(rows) || rows.length === 0) return { kind: "UNKNOWN" };
    const long = String(side).toUpperCase() === "LONG";
    for (const raw of rows) {
      if (!Array.isArray(raw)) continue;
      const o = Number(raw[1]); const h = Number(raw[2]); const l = Number(raw[3]);
      if (![o, h, l].every((v) => Number.isFinite(v) && v > 0)) continue;
      if (long) {
        if (l <= slPrice) return o >= slPrice ? { kind: "SL_FILL" } : { kind: "TRUE_GAP", gapOpenPrice: o };
      } else {
        if (h >= slPrice) return o <= slPrice ? { kind: "SL_FILL" } : { kind: "TRUE_GAP", gapOpenPrice: o };
      }
    }
    return { kind: "UNKNOWN" };
  };
}

// Legacy ladder SWING (40/30/BE/TPmax) dipertahankan untuk posisi lama;
// TIMEOUT tetap tidak ada. SCALP/legacy: single-target (30 Sep).
// Exit FUNDING juga off (fundingExitEnabled: false).
// Fix 9 Okt 2026: overrun besar wajib diverifikasi kline sebelum dianggap gap pasar.
export function exitExecutorForPosition(pos: Pick<PositionRow, "source">): OrderExecutor {
  return String(pos.source ?? "").startsWith("LIVE_") ? activeOrderExecutor : paperPositionExecutor;
}

export const defaultPositionSupervisor = new PositionSupervisor({
  executorForPosition: exitExecutorForPosition,
  fundingExitEnabled: false,
  gapVerifier: createKlineSlGapVerifier(),
});

