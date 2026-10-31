// apps/server/src/strategies/setupStrategies.ts
// EKSEKUSI 3 STRATEGI AKTIF (S-01..S-03) di atas hasil analisis multi-timeframe.
// RENUMBER 6 Okt 2026 (perintah operator: strategi lama dihapus, cukup 3):
//   S-01 Liquidity Sweep Reclaim (eks S-03), S-02 Liquidity Sniper (eks S-04),
//   S-03 Fibonacci Zone 0.5-0.618 (zona entry 7 Okt 2026, semua pair crypto).
// Dihapus: Squeeze Breakout, FVG Continuation, HA Smooth Scalper, ORB & freeze.
// Aturan emas tetap: SEMUA angka (entry/SL/TP/RR) dihitung deterministik di TS; LLM hanya menilai.
//
// INVARIAN (dijaga test):
//   LONG : sl < entry < tp1            SHORT : sl > entry > tp1
//   TP   = RR per strategi dari setupEngine (SCALP 1.5R single-target 100%;
//          SWING ladder TP1/TP2/BE/TPmax — lihat swingLevels/positionSupervisor).
import type { Bar } from "../universe/eligibility.js";
import type { DetectedZone } from "../engines/zoneTriggerEngine.js";
import type { MtfAnalysis } from "../engines/multiTimeframeAnalyzer.js";
import { SETUP_ENGINE, rrPolicyForMode, slBandFor, slBandIsValidateOnly, tpMenuRsFor, slBufferAtrFor, type SetupMode } from "../config/setupEngine.js";
import { getStrategySpec, STRATEGY_SPECS, ARCHIVE_SWING_BREAKOUT_SPEC, type SlBasis, type StrategySpec, type TpBasis } from "./strategyCatalog.js";
import { buildScalpStrategyPlans } from "./scalp/scalpEngine.js";
import { buildSwingStrategyPlans } from "./swing/swingEngine.js";
import { env } from "../core/env.js"; // Import env untuk cek PAPER_DETERMINISTIC_ENTRY
import {
  liquiditySniper,
  detectRangeSweepReclaim,
  type LiquiditySniperOptions,
} from "../engines/indicatorLibrary.js";
import { detectFibRetracement } from "../engines/fibRetracementEngine.js";
import {
  evaluateMrvStretchGate,
  MRV_K,
  type MrvStretchInput,
} from "../engines/mrvStretchEngine.js";
// S-05 Swing Breakout (13 Okt 2026): mesin sinyal port 1:1 v2_breakout.py
// (paritas T-04: 877 sinyal Python 5 simbol 1h Apr-Okt 2026 cocok persis).
import {
  latestSwingBreakoutSignal,
  SWING_SL_MULT,
  SWING_WARMUP,
} from "./swingBreakoutEngine.js";
// (27 Okt 2026: helper council dipindah ke agents/councilEngine.ts —
// runPreEntryCouncil dipanggil dari funnel entry, bukan dari file ini.)
import type { CouncilDecision } from "../agents/councilEngine.js";

export type Side = "LONG" | "SHORT";

/**
 * HARD GATE: Filter CVD (Cumulative Volume Delta).
 * Menolak entry jika tekanan volume berlawanan arah dengan bias teknikal.
 * 
 * @param cumDelta Nilai cumulative delta dari indikator likuiditas/volume.
 * @param side Sisi trade yang diusulkan (LONG/SHORT).
 * @returns true jika SELARAS (boleh lanjut), false jika BERTENTANGAN (veto).
 */
function isCvdAligned(cumDelta: number | undefined | null, side: Side): boolean {
  // Jika data tidak ada, anggap netral/tidak veto (fail-open untuk kompatibilitas backtest lama)
  if (cumDelta === undefined || cumDelta === null || isNaN(cumDelta)) return true;
  
  // Ambang batas sensitivitas: hanya veto jika delta cukup besar (> 0 berarti bullish pressure, < 0 bearish)
  // Untuk scalping agresif, kita ingin konfirmasi kuat. 
  // Logika sederhana: LONG butuh delta >= 0, SHORT butuh delta <= 0.
  // Bisa dituning nanti dengan threshold absolut jika diperlukan.
  if (side === "LONG") return cumDelta >= 0;
  if (side === "SHORT") return cumDelta <= 0;
  return true;
}
export type EntryType = "MARKET_BREAKOUT" | "LIMIT_ZONE" | "MARKET_PULLBACK" | "FIB_RETRACEMENT" | "MEAN_REVERSION_STRETCH";

export interface StrategyPlan {
  strategyId: string;
  /** Explicit replay override; undefined means repository default/runtime version. */
  tp1ROverride?: number;
  strategyName: string;
  mode: SetupMode;
  matched: boolean;
  side: Side;
  entryType: EntryType;
  entryPrice: number;
  slPrice: number;
  tp1Price: number;
  /** Jarak SL relatif harga entry (0.008 = 0.8%). */
  slPct: number;
  /** ATR/price saat SL dihitung (untuk band adaptif di gate entry). Opsional. */
  slAtrPct?: number | null;
  rDistance: number;
  rr1: number;
  quality: number;
  zoneType: string | null;
  zoneTop: number | null;
  zoneBottom: number | null;
  zoneScore: number;
  slBasis: string;
  tpBasis: string;
  reasons: string[];
  tfSummary: string;
  /** Hasil sidang Dewan AI (jika aktif). */
  councilDecision?: CouncilDecision;
}

export interface StrategyContext {
  analysis: MtfAnalysis;
  /** Harga live (mark price) saat evaluasi. */
  price: number;
  mode: SetupMode;
  tp1ROverride?: number;
  /**
   * Data S-04 (opsional): seri 5m bersejarah yang lebih panjang dari jendela
   * MTF standar (90 bar) + opsional bar harian UTC. S-04 butuh >= 200 bar 5m
   * (seed EMA200) dan >= 50 hari UTC lengkap (seed D_EMA50) — tanpa data ini
   * S-04 gagal TERTUTUP dengan alasan MRV_INSUFFICIENT_* (tidak pernah
   * mengarang sinyal). Tidak dibaca S-01/S-02/S-03.
   */
  mrv?: { m5Bars: Bar[]; dailyBars?: Bar[] };
  /**
   * Data S-05 (opsional): bar 1h yang SUDAH TUTUP (anti-lookahead). Live funnel
   * SWING mengambil 300 bar 1h (SWING_TIMEFRAMES) lalu memotong bar berjalan;
   * replay memakai aggregateClosedBars. Tanpa data ini S-05 gagal TERTUTUP
   * (SWING_NO_DATA) — tidak pernah mengarang sinyal. Tidak dibaca S-01..S-04.
   */
  swing?: {
    h1Bars: Bar[];
    /** T0.5 (18 Okt 2026): bar H4 untuk evaluator RSW-01/02/03 (opsional —
     * tanpa ini RSW gagal TERTUTUP, tidak pernah mengarang sinyal). */
    h4Bars?: Bar[];
    /** T0.5: bar 1h panjang (>= 801) untuk RSW-03 (AlgoChief butuh seed
     * EMA/deque panjang). Fallback: h1Bars bila field ini absen. S-05 tetap
     * membaca h1Bars (jendela MTF) — tidak berubah. */
    h1BarsLong?: Bar[];
    /** T0.5: bar D1 BTC untuk gate BTC_D1_ALIGN kaki BOS_LONG RSW-01 (opsional;
     * tanpa ini kaki BOS otomatis tersaring, kaki PHEN tetap hidup). */
    btcDailyBars?: Bar[];
    /** Candidate-only S-05 overrides; undefined = frozen baseline. */
    volContrThresh?: number;
    slMult?: number;
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const round8 = (v: number) => Number(v.toFixed(8));

/** ATR pengganti saat klines trigger kurang (fallback deterministik). */
function atrOrFallback(ctx: StrategyContext): number {
  const atr = ctx.analysis.atrStructure ?? ctx.analysis.atrTrigger;
  if (atr && atr > 0) return atr;
  const price = ctx.price || ctx.analysis.price || 1;
  return price * (ctx.mode === "SCALP" ? 0.004 : 0.008);
}

/**
 * Clamp jarak SL ke band strategi/mode; mengembalikan harga SL final + catatan.
 * Band dengan slBandValidateOnly (S-03 Fib) HANYA memvalidasi: SL struktural
 * tidak pernah digeser; SL di luar band -> INVALID (plan ditolak).
 */
export function clampSlToBand(
  entry: number,
  slRaw: number,
  side: Side,
  mode: SetupMode,
  atrPct?: number | null,
  strategyId?: string
): { sl: number; slPct: number; clamped: "NONE" | "MIN" | "MAX" | "INVALID" } {
  const band = slBandFor(mode, atrPct, strategyId);
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(slRaw) || slRaw <= 0
      || (side === "LONG" ? slRaw >= entry : slRaw <= entry)) return { sl: entry, slPct: 0, clamped: "INVALID" };
  const dist = Math.abs(entry - slRaw);
  let pct = entry > 0 ? dist / entry : 0;
  if (slBandIsValidateOnly(strategyId)) {
    // Validasi saja: tidak ada clamp. Geometri strategi (mis. level 1.0 fib)
    // harus utuh apa adanya; di luar band berarti plan tidak sah.
    if (pct < band.min || pct > band.max) return { sl: slRaw, slPct: pct, clamped: "INVALID" };
    return { sl: round8(slRaw), slPct: Number(pct.toFixed(6)), clamped: "NONE" };
  }
  let clamped: "NONE" | "MIN" | "MAX" = "NONE";
  if (pct < band.min) {
    pct = band.min;
    clamped = "MIN";
  } else if (pct > band.max) {
    // Reject an invalidation outside the policy band instead of stopping inside it.
    return { sl: slRaw, slPct: pct, clamped: "INVALID" };
  }
  const sl = side === "LONG" ? entry * (1 - pct) : entry * (1 + pct);
  return { sl: round8(sl), slPct: Number(pct.toFixed(6)), clamped };
}

/** Ekstrem pivot pada timeframe struktur (untuk SL/TP struktural). */
export function structureExtreme(bars: Bar[], side: Side, lookback: number = SETUP_ENGINE.structureLookbackBars): number | null {
  const slice = bars.slice(-lookback);
  if (slice.length === 0) return null;
  return side === "LONG" ? Math.min(...slice.map((b) => b.low)) : Math.max(...slice.map((b) => b.high));
}

/** Target pivot searah posisi (harga ekstrem terakhir yang belum ditembus). */
export function structureTarget(bars: Bar[], side: Side, entry: number, lookback: number = SETUP_ENGINE.structureLookbackBars): number | null {
  const slice = bars.slice(-lookback);
  if (slice.length === 0) return null;
  if (side === "LONG") {
    const highs = slice.map((b) => b.high).filter((h) => h > entry);
    return highs.length ? Math.max(...highs) : null;
  }
  const lows = slice.map((b) => b.low).filter((l) => l < entry);
  return lows.length ? Math.min(...lows) : null;
}

/** Zona lawan terdekat sebagai target TP2 (basis NEXT_ZONE). */
export function nextOppositeZone(analysis: MtfAnalysis, side: Side, entry: number): DetectedZone | null {
  const zones = (analysis.zoneAnalysis?.allZones ?? []).filter((z) =>
    side === "LONG" ? z.side === "BEARISH" && z.bottom >= entry : z.side === "BULLISH" && z.top <= entry
  );
  if (zones.length === 0) return null;
  return zones.sort((a, b) => (side === "LONG" ? a.bottom - b.bottom : b.top - a.top))[0]!;
}

/** Susun TP1 (RR per mode); ladder TP2/TPmax SWING ditambahkan di jalur swing. */
export function buildTargets(
  entry: number,
  sl: number,
  side: Side,
  mode: SetupMode,
  strategyId?: string,
  tp1ROverride?: number,
): { tp1: number; rDistance: number; usedDefaultRFallback: boolean } {
  const r = Math.abs(entry - sl);
  const policy = rrPolicyForMode(mode, strategyId, tp1ROverride);
  const tp1 = side === "LONG" ? entry + policy.tp1R * r : entry - policy.tp1R * r;
  // Perintah operator 29 Sep 2026: RR KLASIK, SATU target saja (tp1Price).
  return {
    tp1: round8(tp1), rDistance: r,
    usedDefaultRFallback: false,
  };
}

/** Validasi geometri akhir plan (mencegah level terbalik / RR terlalu kecil). */
export function validatePlan(plan: StrategyPlan, entry: number): StrategyPlan {
  const bad: string[] = [];
  if (!(plan.slPrice > 0) || !(plan.tp1Price > 0)) bad.push("LEVEL_NON_POSITIVE");
  // Single-target (perintah operator 29 Sep 2026): satu TP tunggal (tp1Price).
  if (plan.side === "LONG") {
    if (!(plan.slPrice < entry)) bad.push("SL_ABOVE_ENTRY_LONG");
    if (!(plan.tp1Price > entry)) bad.push("TP1_BELOW_ENTRY_LONG");
  } else {
    if (!(plan.slPrice > entry)) bad.push("SL_BELOW_ENTRY_SHORT");
    if (!(plan.tp1Price < entry)) bad.push("TP1_ABOVE_ENTRY_SHORT");
  }
  const r = Math.abs(entry - plan.slPrice);
  if (r <= 0) bad.push("R_ZERO");
  const rr1Full = Math.abs(plan.tp1Price - entry) / (r || 1);
  // RR1_QUANTIZED_FIX (30 Sep 2026): plan.rr1 dikuantisasi ke 3 dp untuk
  // laporan/persistensi, tapi bound policy (SCALP tp1R = 1.5) presisi penuh.
  plan.rr1 = Number(rr1Full.toFixed(3));
  if (plan.rr1 < SETUP_ENGINE.minRr1 - 1e-6) bad.push("RR1_TOO_LOW");
  if (bad.length) {
    plan.matched = false;
    plan.reasons.push(...bad);
  }
  return plan;
}

// ── MENU SL/TP DETERMINISTIK (Opsi 2 Hybrid, 2 Okt 2026) ─────────────────────
// Arka (LLM) menjadi juri entry utama DAN memilih varian SL/TP. Ia hanya
// menyebut ID (A/B/C); semua harga tetap dihitung kode di sini. Tidak ada angka
// mentah dari LLM yang pernah masuk plan atau risk engine.

/** ID varian SL. A = struktural apa adanya, B = struktural + buffer ATR. */
export type SlMenuId = "A" | "B";
/** ID varian TP, dipetakan ke SETUP_ENGINE.slTpMenu.tpR. */
export type TpMenuId = "A" | "B" | "C";

export interface SlMenuVariant {
  id: SlMenuId;
  label: string;
  slPrice: number;
  slPct: number;
  rDistance: number;
  basis: string;
}

export interface TpMenuVariant {
  id: TpMenuId;
  label: string;
  r: number;
}

export interface SlTpMenu {
  entry: number;
  side: Side;
  mode: SetupMode;
  sl: SlMenuVariant[];
  tp: TpMenuVariant[];
  /** Default fail-safe: dipakai bila pilihan LLM tidak valid atau saat outage. */
  defaultSlId: SlMenuId;
  defaultTpId: TpMenuId;
}

const TP_MENU_IDS: readonly TpMenuId[] = ["A", "B", "C"];
/** Pct ATR fallback saat plan tidak membawa slAtrPct (selaras atrOrFallback SCALP). */
const SL_MENU_FALLBACK_ATR_PCT = 0.004;

/**
 * Bangun menu SL/TP pra-hitung dari plan struktural. Deterministik penuh: hanya
 * harga entry, SL struktural plan, dan konfigurasi band/ATR yang dipakai.
 * Mengembalikan null bila SL struktural tidak valid (plan seperti itu sudah
 * ditolak validatePlan, jadi menu tidak perlu ditawarkan).
 */
export function buildSlTpMenu(
  entry: number,
  side: Side,
  plan: Pick<StrategyPlan, "slPrice" | "slAtrPct" | "strategyId">,
  mode: SetupMode
): SlTpMenu | null {
  if (!Number.isFinite(entry) || entry <= 0) return null;
  const atrPct = plan.slAtrPct && plan.slAtrPct > 0 ? plan.slAtrPct : SL_MENU_FALLBACK_ATR_PCT;
  const strategyId = plan.strategyId;
  const base = clampSlToBand(entry, plan.slPrice, side, mode, atrPct, strategyId);
  if (base.clamped === "INVALID") return null;

  const sl: SlMenuVariant[] = [
    { id: "A", label: "struktural", slPrice: base.sl, slPct: base.slPct,
      rDistance: round8(Math.abs(entry - base.sl)), basis: "STRUCTURAL" },
  ];
  // Varian B (SL digeser buffer ATR) TIDAK ditawarkan untuk strategi dengan
  // band validate-only (S-03 Fib): menggeser SL = merusak geometri level 1.0 fib.
  if (!slBandIsValidateOnly(strategyId)) {
    // Varian B: SL struktural digeser satu buffer ATR ke luar (anti stop-hunt).
    const buffer = slBufferAtrFor(mode) * atrPct * entry;
    const bufferedRaw = side === "LONG" ? base.sl - buffer : base.sl + buffer;
    const buffered = clampSlToBand(entry, bufferedRaw, side, mode, atrPct, strategyId);
    if (buffered.clamped !== "INVALID" && buffered.slPct > base.slPct) {
      sl.push({ id: "B", label: "struktural + buffer ATR", slPrice: buffered.sl,
        slPct: buffered.slPct, rDistance: round8(Math.abs(entry - buffered.sl)),
        basis: "STRUCTURAL_ATR_BUFFER" });
    }
  }

  const tp: TpMenuVariant[] = [];
  tpMenuRsFor(strategyId, mode).forEach((r, i) => {
    if (!Number.isFinite(r) || r < SETUP_ENGINE.minRr1) return;
    tp.push({ id: TP_MENU_IDS[i]!, label: `${r}R`, r });
  });
  if (tp.length === 0) return null;

  return { entry, side, mode, sl, tp, defaultSlId: "A", defaultTpId: "A" };
}

export interface AppliedSlTpChoice {
  plan: StrategyPlan;
  slId: SlMenuId;
  tpId: TpMenuId;
  /** true bila pilihan tidak valid/kosong sehingga default deterministik dipakai. */
  fellBack: boolean;
}

/**
 * Terapkan pilihan ID menu ke plan. STRICT fail-safe: bila SALAH SATU pilihan
 * (SL atau TP) tidak valid/kosong, pakai plan default penuh (A/A) — respons
 * malformed tidak dipercaya sebagian. Hanya ID yang dihormati; harga SL/TP selalu
 * dihitung ulang di sini. R TP ditulis ke plan.tp1ROverride supaya risk engine
 * (satu-satunya pemilik qty/margin) menghitung TP1/TP2 pada R yang sama.
 */
export function applySlTpChoice(
  plan: StrategyPlan,
  menu: SlTpMenu | null,
  slId: string | null | undefined,
  tpId: string | null | undefined
): AppliedSlTpChoice {
  if (!menu) return { plan, slId: "A", tpId: "A", fellBack: true };
  const slReq = menu.sl.find((v) => v.id === slId);
  const tpReq = menu.tp.find((v) => v.id === tpId);
  const valid = slReq !== undefined && tpReq !== undefined;
  const slVariant = valid ? slReq : (menu.sl.find((v) => v.id === menu.defaultSlId) ?? menu.sl[0]);
  const tpVariant = valid ? tpReq : (menu.tp.find((v) => v.id === menu.defaultTpId) ?? menu.tp[0]);
  if (!slVariant || !tpVariant) return { plan, slId: "A", tpId: "A", fellBack: true };
  const fellBack = !valid;

  const entry = Number.isFinite(menu.entry) && menu.entry > 0 ? menu.entry : plan.entryPrice;
  const rDistance = Math.abs(entry - slVariant.slPrice);
  if (!(rDistance > 0)) return { plan, slId: slVariant.id, tpId: tpVariant.id, fellBack: true };
  const dir = menu.side === "LONG" ? 1 : -1;
  const tp1Price = round8(entry + dir * tpVariant.r * rDistance);

  const applied: StrategyPlan = {
    ...plan,
    entryPrice: round8(entry),
    slPrice: round8(slVariant.slPrice),
    slPct: slVariant.slPct,
    rDistance: round8(rDistance),
    tp1Price,
    slBasis: slVariant.basis,
    tpBasis: `MENU_RR_${tpVariant.id}`,
    // Satu-satunya jalur angka: override R dari menu -> dibaca rrPolicyForMode.
    tp1ROverride: tpVariant.r,
    reasons: [...plan.reasons, `MENU_SL_${slVariant.id}`, `MENU_TP_${tpVariant.id}`,
      ...(fellBack ? ["MENU_FALLBACK_DEFAULT"] : [])],
  };
  return { plan: validatePlan(applied, entry), slId: slVariant.id, tpId: tpVariant.id, fellBack };
}

/** Kerangka plan kosong untuk strategi yang tidak match (dipakai audit). */
function basePlan(spec: StrategySpec, ctx: StrategyContext, side: Side, entryType: EntryType): StrategyPlan {
  return {
    strategyId: spec.id,
    tp1ROverride: ctx.tp1ROverride,
    strategyName: spec.name,
    mode: ctx.mode,
    matched: false,
    side,
    entryType,
    entryPrice: round8(ctx.price || ctx.analysis.price || 0),
    slPrice: 0,
    tp1Price: 0,
    slPct: 0,
    rDistance: 0,
    rr1: 0,
    quality: 0,
    zoneType: null,
    zoneTop: null,
    zoneBottom: null,
    zoneScore: 0,
    slBasis: spec.slBasis,
    tpBasis: spec.tpBasis,
    reasons: [],
    tfSummary: ctx.analysis.tfSummary,
  };
}

/**
 * 20 Okt 2026 (perintah operator: "untuk yang fibo tolong hapus itu" + "hapus
 * juga S-04 di strategi scalp"): S-03 Fibonacci dan S-04 Mean-Reversion
 * Stretch DIHAPUS dari katalog aktif, jadi `getStrategySpec("S-03"/"S-04")`
 * sudah mengembalikan null.
 *
 * Fail-closed (Rules.md 1.10): kegagalan menjawab TIDAK BOLEH menjadi izin.
 * Evaluator arsip (dipakai skrip riset offline + replayer) harus mengembalikan
 * plan matched=false dengan alasan eksplisit — BUKAN crash TypeError saat
 * `basePlan(spec, ...)` membaca `spec.id` dari spec null.
 *
 * Plan retired tetap dibuat (bukan null) supaya alur lama fail-closed dengan
 * alasan tercatat: `matched=false` + `reasons=["STRATEGY_RETIRED"]`.
 * Helper ini DI-EKSPOR supaya skrip riset offline yang mengekstrak source
 * function (research/swing_1000_signals.ts) bisa memakainya.
 */
export function retiredStrategyPlan(
  strategyId: "S-03" | "S-04",
  ctx: StrategyContext,
  opts: { strategyName: string; entryType: EntryType; slBasis: SlBasis; tpBasis: TpBasis },
): StrategyPlan {
  return {
    strategyId,
    tp1ROverride: ctx.tp1ROverride,
    strategyName: opts.strategyName,
    mode: ctx.mode,
    matched: false,
    side: ctx.analysis.side,
    entryType: opts.entryType,
    entryPrice: round8(ctx.price || ctx.analysis.price || 0),
    slPrice: 0,
    tp1Price: 0,
    slPct: 0,
    rDistance: 0,
    rr1: 0,
    quality: 0,
    zoneType: null,
    zoneTop: null,
    zoneBottom: null,
    zoneScore: 0,
    slBasis: opts.slBasis,
    tpBasis: opts.tpBasis,
    reasons: ["STRATEGY_RETIRED"],
    tfSummary: ctx.analysis.tfSummary,
  };
}

/** Zona usable yang cocok untuk sisi tertentu (DEMAND/BULLISH untuk LONG). */
function usableZoneFor(analysis: MtfAnalysis, side: Side): DetectedZone | null {
  const wanted = side === "LONG" ? "BULLISH" : "BEARISH";
  const zones = (analysis.zoneAnalysis?.usableZones ?? []).filter((z) => z.side === wanted && z.score >= SETUP_ENGINE.minZoneScore);
  if (zones.length === 0) return null;
  return zones.sort((a, b) => b.score - a.score)[0]!;
}

/** Apakah harga sedang menguji / dekat zona (anti entry basi). */
function proximityToZone(entry: number, zone: DetectedZone): { near: boolean; inside: boolean; distancePct: number } {
  const inside = entry <= zone.top && entry >= zone.bottom;
  const edge = entry > zone.top ? zone.top : entry < zone.bottom ? zone.bottom : entry;
  const distancePct = entry > 0 ? Math.abs(entry - edge) / entry : 1;
  return { near: inside || distancePct <= SETUP_ENGINE.zoneProximityPct, inside, distancePct };
}

/** Tandai zona POI yang dipakai plan (audit). */
function markZone(plan: StrategyPlan, zone: DetectedZone | null): void {
  if (!zone) return;
  plan.zoneType = zone.type;
  plan.zoneTop = round8(zone.top);
  plan.zoneBottom = round8(zone.bottom);
  plan.zoneScore = zone.score;
}

/** Resolusi entry: hanya boleh entry di harga yang dekat harga live (simulasi fill realistis). */
function resolveEntry(ctx: StrategyContext, preferred: number, maxGapPct: number): number | null {
  const live = ctx.price || ctx.analysis.price;
  if (!(live > 0)) return null;
  const gap = Math.abs(preferred - live) / live;
  if (!(gap <= maxGapPct)) return null;
  return round8(live);
}

/**
 * S-01 Liquidity Sweep Reclaim (SCALP) — eks S-03 sebelum renumber 6 Okt 2026.
 *
 * Basis indikator "Liquidity Sweep Session [TradingFinder] ICT Killzone Times":
 * likuiditas sesi (low/high hari sebelumnya atau range Asia) disapu di dalam
 * killzone, lalu harga RECLAIM level itu dengan displacement. Entry hanya
 * setelah reclaim terkonfirmasi — bukan saat harga masih di luar level.
 *
 * Invarian: SL di ekstrem sweep (invalidation struktural), TP single target 1.5R.
 */
export function evaluateLiquiditySweepReclaim(ctx: StrategyContext): StrategyPlan {
  const spec = getStrategySpec("S-01")!;
  const plan = basePlan(spec, ctx, ctx.analysis.side, "LIMIT_ZONE");
  if (ctx.mode !== "SCALP") {
    plan.reasons.push("MODE_NOT_SCALP");
    return plan;
  }
  if (!ctx.analysis.usable) {
    plan.reasons.push(ctx.analysis.reason ?? "MTF_NOT_USABLE");
    return plan;
  }

  // Jalur LIVE memakai jendela klines terbatas -> varian range-based.
  const bars = ctx.analysis.structure.barsData.length >= 40
    ? ctx.analysis.structure.barsData
    : ctx.analysis.trigger.barsData;
  const setup = detectRangeSweepReclaim(bars, 30, { requireKillzone: false });
  
  // AGGRESSIVE BYPASS for PAPER_DETERMINISTIC_ENTRY
  let finalSide: Side | null = null;
  let invalidationPrice: number | null = null;

  if (setup) {
    finalSide = setup.side;
    invalidationPrice = setup.invalidationPrice;
    
    // Veto cermin: jangan melawan bias KUAT (pola sama seperti S-01).
    const b = ctx.analysis.bias;
    const opposingStrong =
      (finalSide === "LONG" ? b.trend === "BEARISH" : b.trend === "BULLISH") &&
      ((b.trendScore ?? 0) >= 65 || (b.adx ?? 0) >= 30);
      
    if (opposingStrong && !env.PAPER_DETERMINISTIC_ENTRY) {
      plan.reasons.push("SWEEP_MIRROR_VETO_STRONG_BIAS");
      return plan;
    }
  } else if (env.PAPER_DETERMINISTIC_ENTRY) {
    // Fallback: Gunakan arah bias MTF sederhana jika pola Sweep tidak ada
    const b = ctx.analysis.bias;
    if (b.trend === "BULLISH") {
      finalSide = "LONG";
      // Invalidation: Low dari 10 bar terakhir
      invalidationPrice = Math.min(...bars.slice(-10).map(bar => bar.low));
      plan.reasons.push("AGGRESSIVE_FALLBACK_TREND_LONG");
    } else if (b.trend === "BEARISH") {
      finalSide = "SHORT";
      // Invalidation: High dari 10 bar terakhir
      invalidationPrice = Math.max(...bars.slice(-10).map(bar => bar.high));
      plan.reasons.push("AGGRESSIVE_FALLBACK_TREND_SHORT");
    } else {
      plan.reasons.push("NO_LIQUIDITY_SWEEP_RECLAIM_AND_NO_TREND");
      return plan;
    }
  } else {
    plan.reasons.push("NO_LIQUIDITY_SWEEP_RECLAIM");
    return plan;
  }

  const side = finalSide!;
  const invPrice = invalidationPrice!;

  const entry = resolveEntry(ctx, ctx.price || ctx.analysis.price, SETUP_ENGINE.maxEntryGapPct.SCALP);
  if (entry === null) {
    plan.reasons.push("ENTRY_NOT_AT_MARKET");
    return plan;
  }

  // --- CVD HARD GATE INTEGRATION (S-01) ---
  // Estimasi Delta dari bars jika tidak ada liq result langsung di scope ini.
  // Kita gunakan bar terakhir untuk snapshot cepat.
  const lastBars = ctx.analysis.structure.barsData.slice(-5);
  const recentCumDelta = lastBars.reduce((acc, b) => acc + ((b.close >= b.open ? 1 : -1) * b.volume), 0);
  
  if (!isCvdAligned(recentCumDelta, side)) {
    plan.reasons.push("CVD_CONFLICT_VETO");
    return plan; // VETO MUTLAK
  }
  // ----------------------------------------

  const atr = ctx.analysis.atrStructure ?? atrOrFallback(ctx);
  const buffer = slBufferAtrFor(ctx.mode) * atr;
  const slRaw = side === "LONG" ? invPrice - buffer : invPrice + buffer;
  const slAtrPct = entry > 0 ? atr / entry : null;
  const sl = clampSlToBand(entry, slRaw, side, ctx.mode, slAtrPct);
  if (sl.clamped === "INVALID") {
    plan.reasons.push("SL_INVALID");
    return plan;
  }
  if (sl.clamped !== "NONE") plan.reasons.push(`SL_CLAMPED_${sl.clamped}`);

  const tgt = buildTargets(entry, sl.sl, side, ctx.mode, spec.id, ctx.tp1ROverride);
  plan.matched = true;
  plan.side = side;
  plan.entryPrice = entry;
  plan.slPrice = sl.sl;
  plan.slPct = sl.slPct;
  plan.slAtrPct = slAtrPct;
  plan.tp1Price = tgt.tp1;
  plan.rDistance = tgt.rDistance;
  markZone(plan, ctx.analysis.bestZone);
  
  // Hitung bonus kualitas hanya jika setup asli ada; jika fallback, gunakan skor dasar rendah
  let qualityScore = 30; // Base score for aggressive fallback
  
  // Guard ketat terhadap null/undefined untuk mencegah runtime error
  if (setup != null && typeof setup === 'object') {
    try {
      const sweepDepth = Number(setup.sweepDepthAtr) || 0;
      const displacement = Number(setup.displacementAtr) || 0;
      
      const depthBonus = clamp(Math.round(sweepDepth * 40), 0, 15);
      const dispBonus = clamp(Math.round(displacement * 40), 0, 15);
      qualityScore += depthBonus + dispBonus + (ctx.analysis.biasAligned ? 10 : 0);
      
      plan.reasons.push(
        `SWEEP_${side}_${setup.sweptRange ?? 'UNKNOWN'}`,
        `SWEEP_DEPTH_ATR_${sweepDepth}`,
        `RECLAIM_DISPLACEMENT_ATR_${displacement}`,
        ...(setup.killzone ? [`KILLZONE_${setup.killzone}`] : ["KILLZONE_ABSENT"])
      );
    } catch (e) {
      // Jika terjadi error tak terduga pada parsing setup, anggap sebagai fallback
      plan.reasons.push("SETUP_PARSE_ERROR_FALLBACK");
      qualityScore = 30; 
    }
  } else {
    plan.reasons.push(`AGGRESSIVE_TREND_FOLLOW_${side}`);
  }
  
  plan.quality = clamp(Math.round(qualityScore), 0, 100);
  return validatePlan(plan, entry);
}

/** Jarak maksimum entry ke harga live (SCALP-only sejak 30 Sep 2026). */
function maxEntryGapFor(_mode: SetupMode): number {
  return SETUP_ENGINE.maxEntryGapPct.SCALP;
}

/**
 * S-02 Liquidity Sniper — SCALP-only (eks S-04 sebelum renumber 6 Okt 2026).
 *
 * Basis indikator "Liquidity Sniper": peta likuiditas (liquidation engine tier
 * leverage + stop pools pivot) yang di-merge jadi wall, lalu magnet atas/bawah +
 * liquidity pull bias. Arah trade mengikuti sisi yang lebih "menarik" harga:
 * pullBias UP (likuiditas dominan di atas) -> LONG menuju short magnet;
 * pullBias DOWN -> SHORT menuju long magnet.
 *
 * Semua parameter mengikuti mode SCALP (SL band, buffer/min SL ATR, jarak
 * entry, RR target tunggal). Konfirmasi: pullBias harus searah bias trend MTF.
 */
export function evaluateLiquiditySniper(ctx: StrategyContext, liquidityOptions?: LiquiditySniperOptions): StrategyPlan {
  const spec = getStrategySpec("S-02")!;
  const plan = basePlan(spec, ctx, ctx.analysis.side, "MARKET_PULLBACK");
  if (!ctx.analysis.usable) {
    plan.reasons.push(ctx.analysis.reason ?? "MTF_NOT_USABLE");
    return plan;
  }

  const bars = ctx.analysis.structure.barsData.length >= 40
    ? ctx.analysis.structure.barsData
    : ctx.analysis.trigger.barsData;
  const liq = liquiditySniper(bars, liquidityOptions);
  
  // AGGRESSIVE BYPASS for PAPER_DETERMINISTIC_ENTRY
  let finalSide: Side | null = null;
  let invCandidatePrice: number | null = null;
  let isAggressiveFallback = false;

  if (liq && liq.pullBias !== "NEUTRAL") {
    const sideFromLiq: Side = liq.pullBias === "UP" ? "LONG" : "SHORT";
    
    // Cek kesesuaian arah likuiditas vs bias trend MTF
    const trend = ctx.analysis.bias.trend;
    const trendMatch = (sideFromLiq === "LONG" && trend === "BULLISH") || (sideFromLiq === "SHORT" && trend === "BEARISH");
    
    // Target magnet harus ada & cukup kuat sebagai tujuan harga.
    const targetMagnet = sideFromLiq === "LONG" ? liq.shortMagnet : liq.longMagnet;
    
    if (trendMatch && targetMagnet) {
      finalSide = sideFromLiq;
      const invalidMagnet = sideFromLiq === "LONG" ? liq.longMagnet : liq.shortMagnet;
      invCandidatePrice = invalidMagnet?.price ?? null;
    } else if (env.PAPER_DETERMINISTIC_ENTRY) {
      // Fallback agresif: paksa ikut arah trend MTF saja jika liq map tidak sempurna
      if (trend === "BULLISH") {
        finalSide = "LONG";
        invCandidatePrice = null; // Akan pakai lastBar.low nanti
        isAggressiveFallback = true;
        plan.reasons.push("AGGR_SNIPER_TREND_LONG");
      } else if (trend === "BEARISH") {
        finalSide = "SHORT";
        invCandidatePrice = null;
        isAggressiveFallback = true;
        plan.reasons.push("AGGR_SNIPER_TREND_SHORT");
      } else {
        plan.reasons.push(trendMatch ? "NO_TARGET_MAGNET" : "LIQUIDITY_TREND_MISMATCH");
        return plan;
      }
    } else {
      plan.reasons.push(!trendMatch ? "LIQUIDITY_TREND_MISMATCH" : "NO_TARGET_MAGNET");
      return plan;
    }
  } else if (env.PAPER_DETERMINISTIC_ENTRY) {
    // Liq map empty ATAU pullBias NEUTRAL -> fallback ke trend MTF
    const trend = ctx.analysis.bias.trend;
    if (trend === "BULLISH") {
      finalSide = "LONG";
      invCandidatePrice = null;
      isAggressiveFallback = true;
      plan.reasons.push(liq ? "AGGR_SNIPER_NEUTRAL_TO_LONG" : "AGGR_SNIPER_EMPTY_TO_LONG");
    } else if (trend === "BEARISH") {
      finalSide = "SHORT";
      invCandidatePrice = null;
      isAggressiveFallback = true;
      plan.reasons.push(liq ? "AGGR_SNIPER_NEUTRAL_TO_SHORT" : "AGGR_SNIPER_EMPTY_TO_SHORT");
    } else {
      plan.reasons.push(liq ? "PULL_BIAS_NEUTRAL_NO_TREND" : "LIQUIDITY_MAP_EMPTY_NO_TREND");
      return plan;
    }
  } else {
    plan.reasons.push(liq ? "PULL_BIAS_NEUTRAL" : "LIQUIDITY_MAP_EMPTY");
    return plan;
  }

  const side = finalSide!;

  const entry = resolveEntry(ctx, ctx.price || ctx.analysis.price, maxEntryGapFor(ctx.mode));
  if (entry === null) {
    plan.reasons.push("ENTRY_NOT_AT_MARKET");
    return plan;
  }

  // --- CVD HARD GATE INTEGRATION (S-02) ---
  // Gunakan cumDelta dari hasil liquiditySniper jika tersedia, fallback ke estimasi bars.
  const cvdValue = liq ? liq.cumDelta : (() => {
    const recentBars = bars.slice(-5);
    return recentBars.reduce((acc, b) => acc + ((b.close >= b.open ? 1 : -1) * b.volume), 0);
  })();

  if (!isCvdAligned(cvdValue, side)) {
    plan.reasons.push("CVD_CONFLICT_VETO");
    return plan; // VETO MUTLAK
  }
  // ----------------------------------------

  const atr = ctx.analysis.atrStructure ?? atrOrFallback(ctx);
  const slAtrPct = entry > 0 ? atr / entry : null;
  const band = slBandFor(ctx.mode, slAtrPct);
  const buffer = slBufferAtrFor(ctx.mode) * atr;
  const lastBar = bars[bars.length - 1]!;
  // Invalidation: magnet berlawanan bila masih dalam band SL mode, else ekstrem
  // bar terakhir (agar SL selalu valid dan jarak tetap dalam kebijakan band).
  const defaultInv = side === "LONG" ? lastBar.low : lastBar.high;
  const candidate = invCandidatePrice ?? defaultInv;
  const invDistPct = entry > 0 ? Math.abs(entry - candidate) / entry : 0;
  const invLevel = invDistPct <= band.max ? candidate : defaultInv;
  const slRaw = side === "LONG" ? invLevel - buffer : invLevel + buffer;
  const sl = clampSlToBand(entry, slRaw, side, ctx.mode, slAtrPct);
  if (sl.clamped === "INVALID") {
    plan.reasons.push("SL_INVALID");
    return plan;
  }
  if (sl.clamped !== "NONE") plan.reasons.push(`SL_CLAMPED_${sl.clamped}`);
  void isAggressiveFallback; // reserved for future scoring adjustment

  const tgt = buildTargets(entry, sl.sl, side, ctx.mode, spec.id, ctx.tp1ROverride);
  plan.matched = true;
  plan.side = side;
  plan.entryPrice = entry;
  plan.slPrice = sl.sl;
  plan.slPct = sl.slPct;
  plan.slAtrPct = slAtrPct;
  plan.tp1Price = tgt.tp1;
  plan.rDistance = tgt.rDistance;
  markZone(plan, ctx.analysis.bestZone);
  const bias = ctx.analysis.bias;
  
  // Hitung komponen kualitas dengan aman terhadap null (mode agresif mungkin tidak punya liq/targetMagnet lengkap)
  let magnetIntensityScore = 0;
  if (!isAggressiveFallback && liq) {
    // Cari target magnet lagi jika kita berada di jalur non-agresif tapi perlu validasi ulang scope
    // Namun karena logic di atas sudah set finalSide, kita asumsikan jika !isAggressiveFallback maka liq valid & ada magnet
    const tm = side === "LONG" ? liq.shortMagnet : liq.longMagnet;
    if (tm) magnetIntensityScore = tm.intensity * 30;
  } else {
    // Fallback agresif: berikan skor dasar moderat berdasarkan trend strength saja
    magnetIntensityScore = bias.trendScore * 0.2; 
  }

  const deltaAlign = liq ? ((side === "LONG" && liq.barDelta > 0) || (side === "SHORT" && liq.barDelta < 0) ? 10 : 0) : 0;
  const adxBonus = (bias.adx ?? 0) >= 20 ? 15 : 0;
  
  plan.quality = clamp(
    Math.round(bias.trendScore * 0.4 + magnetIntensityScore + adxBonus + deltaAlign + ctx.analysis.zoneScore * 0.1),
    0,
    100
  );

  if (liq) {
    plan.reasons.push(
      `PULL_BIAS_${liq.pullBias}`,
      `LIQ_ABOVE_${liq.totalIntensityAbove}`,
      `LIQ_BELOW_${liq.totalIntensityBelow}`,
      `BAR_DELTA_${liq.barDelta > 0 ? "POS" : "NEG"}`,
      `CVD_GATE_PASS_${cvdValue.toFixed(0)}`
    );
    // Tambahkan detail magnet hanya jika tersedia
    const tm = side === "LONG" ? liq.shortMagnet : liq.longMagnet;
    if (tm) {
       plan.reasons.push(`TARGET_MAGNET_${tm.price}`, `MAGNET_INTENSITY_${tm.intensity}`);
    }
  } else {
     plan.reasons.push("AGGRESSIVE_NO_LIQ_DATA", `CVD_GATE_PASS_EST_${cvdValue.toFixed(0)}`);
  }
  
  return validatePlan(plan, entry);
}

/**
 * S-03 Fibonacci Zone 0.5-0.618 (SCALP) — BARU 6 Okt 2026; ZONA ENTRY 0.5-0.618
 * + TP DIPAKSA 1.5R sejak 7 Okt 2026 (keputusan operator, semua pair crypto).
 *
 * Basis: riset backtest BTC/USDT M5 dengan engine fibRetracementEngine.ts
 * (deteksi 1:1 engine riset, anti-lookahead). Setelah BOS pada leg swing
 * (pivot N=4, delay konfirmasi N bar), level dihitung kode: entry = level 0.5
 * (batas zona 0.5-0.618 yang tersentuh pertama — harga yang retrace selalu
 * melewati 0.5 sebelum 0.618), SL level 1.0 (ekstrem swing, TIDAK pernah
 * digeser), TP DIPAKSA 1.5R dari entry (bukan level 0.0 struktural).
 * Dasar zona: backtest fib_zone_backtest.py 540 hari — varian zona 0.5 +
 * TP 1.5R satu-satunya yang positif di kedua bound intrabar (PF 1.008-1.026,
 * WR ~40,6%); baseline 0.618/TP 0.0 negatif pada jendela yang sama.
 *
 * Entry = market saat harga live MENCAPAI area zona (toleransi
 * maxEntryGapPct) — bukan limit maker; sesuai keputusan operator 6 Okt 2026
 * supaya funnel existing tetap dipakai tanpa mekanisme order baru.
 * Tanpa filter jam/sesi (crypto 24/7, veto permanen operator 4 Okt 2026), tanpa
 * filter tren 15m (dihapus 7 Okt 2026 atas perintah operator), dan tanpa
 * trailing/partial exit (veto permanen operator).
 */
export function evaluateFibRetracement(ctx: StrategyContext): StrategyPlan {
  const spec = getStrategySpec("S-03", ctx.mode);
  // 20 Okt 2026: S-03 Fibonacci DIHAPUS dari katalog aktif -> spec null.
  // Fail-closed: plan retired (matched=false + STRATEGY_RETIRED), BUKAN crash
  // TypeError dari `basePlan(spec, ...)` yang membaca spec.id.
  if (!spec) {
    return retiredStrategyPlan("S-03", ctx, {
      strategyName: "Fibonacci Zone 0.5-0.618",
      entryType: "FIB_RETRACEMENT",
      slBasis: "FIB_SWING_EXTREME",
      tpBasis: "R_MULTIPLE",
    });
  }
  const plan = basePlan(spec, ctx, ctx.analysis.side, "FIB_RETRACEMENT");
  // 14 Okt 2026 (perintah operator: metode SWING di paper & live, fibo ikut
  // swing): S-03 juga dipakai di lane SWING — zona fibo dihitung dari bar
  // struktur mode tsb (SCALP 5m, SWING 1h). Mesin & geometri TIDAK berubah.
  if (ctx.mode !== "SCALP" && ctx.mode !== "SWING") {
    plan.reasons.push("MODE_NOT_SUPPORTED");
    return plan;
  }
  if (!ctx.analysis.usable) {
    plan.reasons.push(ctx.analysis.reason ?? "MTF_NOT_USABLE");
    return plan;
  }

  // Basis bar = TF struktur mode masing-masing (SCALP 5m = timeframe riset
  // backtest M5; SWING 1h = bar swing yang SUDAH TUTUP). 14 Okt 2026 (perintah
  // operator): di lane SWING zona fibo dihitung BERBASIS CLOSE candle —
  // pivot & ekstrem leg dari harga close, bukan wick (closeBased=true).
  const bars = ctx.analysis.structure.barsData.length >= 40
    ? ctx.analysis.structure.barsData
    : ctx.analysis.trigger.barsData;
  const setup = detectFibRetracement(bars, { closeBased: ctx.mode === "SWING" });
  if (!setup) {
    plan.reasons.push("NO_FIB_SETUP_ARMED");
    return plan;
  }

  // 7 Okt 2026 (perintah operator): filter tren 15m DIHAPUS — arah setup tidak
  // lagi diwajibkan searah tren 15m (reason FIB_TREND_MISALIGNED_* tidak ada
  // lagi). Dasar: engine riset backtest memang tanpa filter tren; tujuan =
  // frekuensi setup Fib lebih tinggi. SL level 1.0 tetap pengaman -1R.

  // Entry hanya valid saat harga live sudah mencapai zona 0.5-0.618 (level 0.5).
  const entry = resolveEntry(ctx, setup.entryLevel, maxEntryGapFor(ctx.mode));
  if (entry === null) {
    plan.reasons.push("FIB_ENTRY_LEVEL_NOT_REACHED");
    return plan;
  }

  const side = setup.side;
  const atr = ctx.analysis.atrStructure ?? atrOrFallback(ctx);
  const slAtrPct = entry > 0 ? atr / entry : null;
  // 14 Okt 2026 (perintah operator, kasus MAGMAUSDT): perbaikan logika
  // penempatan SL lane SWING — strategi TETAP S-03 fib, tapi SL struktural
  // level 1.0 yang berasal dari leg 1h yang KECIL menghasilkan SL setipis
  // scalping (0.75%) => notional/margin membengkak. SL kini minimal 1x ATR(1h)
  // dari entry: bila jarak SL struktural < 1 ATR, SL dilebarkan ke 1 ATR
  // (menghormati volatilitas struktur 1h). Lantai band 1.2% tetap berlaku;
  // SL yang sudah lebar tidak pernah digeser.
  let slLevel = setup.slLevel;
  if (ctx.mode === "SWING" && Number.isFinite(atr) && atr > 0) {
    const minDist = Math.max(atr, entry * 0.012);
    if (Math.abs(entry - slLevel) < minDist) {
      slLevel = side === "LONG" ? entry - minDist : entry + minDist;
      plan.reasons.push(`FIB_SWING_SL_WIDENED_ATR_${round8(slLevel)}`);
    }
  }
  // SCALP: SL tepat di level 1.0 fib apa adanya (tanpa buffer); band hanya memvalidasi.
  const sl = clampSlToBand(entry, slLevel, side, ctx.mode, slAtrPct, spec.id);
  if (sl.clamped === "INVALID") {
    plan.reasons.push("FIB_SL_OUT_OF_BAND");
    return plan;
  }

  // SWING memakai RR23: TP1 2R + final TP2 3R, bukan override 1.7R khas S-03
  // SCALP. strategyId TIDAK diteruskan di mode SWING sehingga rrPolicyForMode
  // memakai rrByMode.SWING. Di SCALP geometri lama (override 1.7R) tetap utuh.
  const swingTp = ctx.mode === "SWING";
  const tgt = buildTargets(entry, sl.sl, side, ctx.mode, swingTp ? undefined : spec.id, ctx.tp1ROverride);
  plan.matched = true;
  plan.side = side;
  plan.entryPrice = entry;
  plan.slPrice = sl.sl;
  plan.slPct = sl.slPct;
  plan.slAtrPct = slAtrPct;
  plan.tp1Price = tgt.tp1;
  plan.rDistance = tgt.rDistance;
  markZone(plan, ctx.analysis.bestZone);
  plan.quality = clamp(
    Math.round(55 + (ctx.analysis.biasAligned ? 10 : 0) + ctx.analysis.zoneScore * 0.1),
    0,
    100
  );
  const rrUsed = Math.abs(tgt.tp1 - entry) / (tgt.rDistance || 1);
  plan.reasons.push(
    `FIB_BOS_${side}`,
    `FIB_ENTRY_0.5_${round8(setup.entryLevel)}`,
    `FIB_SL_1.0_${round8(setup.slLevel)}`,
    `FIB_LEVEL_0.0_${round8(setup.tpLevel)}`,
    `FIB_RANGE_${round8(setup.range)}`,
    `FIB_RR_${rrUsed.toFixed(3)}`,
    `FIB_BARS_SINCE_BOS_${setup.barsSinceBos}`,
    ...(swingTp ? ["FIB_CLOSE_BASED_ZONE", "FIB_SWING_TP_2R_BE_3R"] : [])
  );
  return validatePlan(plan, entry);
}


/**
 * S-04 Mean-Reversion Stretch + Trend Gate (kandidat 7 Okt 2026) — spek:
 * docs/S-04-mrv-stretch-trend-gate.md. Port mode "Mean Reversion" dari
 * "Adaptive Dual Engine - Momentum + Mean Reversion [BT]" (patelanishp).
 *
 * Gate dievaluasi di close bar 5m yang SUDAH TUTUP (engine mrvStretchEngine,
 * deterministik murni): stretch 0.5*ATR14 menjauh dari EMA40 + RSI2 ekstrem
 * (LONG < 15 / SHORT > 85) + filter tren EMA200 + konfirmasi HTF harian
 * (D_CLOSE vs D_EMA50, candle harian UTC yang SUDAH TUTUP — anti-repaint).
 * Tanpa filter jam/sesi (24/7, spek §3), tanpa CVD/zone/momentum tambahan —
 * spek tidak menyebutnya, jadi TIDAK ditambahkan (tidak mengarang perilaku).
 *
 * Exit TIDAK BERUBAH, model ArtaTrade (spek §4): R = 1.0 * ATR14 pada bar
 * sinyal (k=1), SL = entry -/+ 1.0R, TP = entry +/- 1.5R, single target 100%
 * — dihitung lewat clampSlToBand (band S-04 validate-only: SL tidak pernah
 * digeser) + buildTargets + validatePlan seperti strategi lain.
 *
 * Data: S-04 butuh seri 5m >= 200 bar dan >= 50 hari UTC lengkap. Jendela MTF
 * standar (90 bar) TIDAK cukup — tanpa ctx.mrv, plan gagal TERTUTUP dengan
 * alasan MRV_INSUFFICIENT_* (kandidat tidak pernah dipaksakan dari data
 * kurang).
 */
export function evaluateMrvStretch(ctx: StrategyContext): StrategyPlan {
  const spec = getStrategySpec("S-04");
  // 20 Okt 2026: S-04 Mean-Reversion Stretch DIHAPUS dari katalog aktif ->
  // spec null. Fail-closed: plan retired (matched=false + STRATEGY_RETIRED).
  if (!spec) {
    return retiredStrategyPlan("S-04", ctx, {
      strategyName: "Mean-Reversion Stretch + Trend Gate",
      entryType: "MEAN_REVERSION_STRETCH",
      slBasis: "ATR_R_MULTIPLE",
      tpBasis: "R_MULTIPLE",
    });
  }
  const plan = basePlan(spec, ctx, ctx.analysis.side, "MEAN_REVERSION_STRETCH");
  if (ctx.mode !== "SCALP") {
    plan.reasons.push("MODE_NOT_SCALP");
    return plan;
  }
  if (!ctx.analysis.usable) {
    plan.reasons.push(ctx.analysis.reason ?? "MTF_NOT_USABLE");
    return plan;
  }

  // Seri indikator S-04 = close 5m (spek §1). Data kaya (ctx.mrv) bila ada;
  // selain itu jendela struktur MTF apa adanya (bisa gagal tutup = fail-closed).
  const m5Bars = ctx.mrv?.m5Bars ?? ctx.analysis.structure.barsData;
  const nowMs = Number.isFinite(ctx.analysis.analyzedAt) && ctx.analysis.analyzedAt > 0
    ? ctx.analysis.analyzedAt
    : undefined;
  const gateInput: MrvStretchInput = {
    m5Bars,
    dailyBars: ctx.mrv?.dailyBars,
    nowMs,
    // Anti-repaint (preseden S-03/fibRetracementEngine): bar terakhir pada data
    // live selalu candle berjalan — deteksi hanya memakai bar yang sudah tutup.
    includeLastBar: false,
  };
  const gate = evaluateMrvStretchGate(gateInput);
  if (!gate.signal) {
    plan.reasons.push(...gate.reasons);
    return plan;
  }
  const side: Side = gate.signal;

  const entry = resolveEntry(ctx, ctx.price || ctx.analysis.price, SETUP_ENGINE.maxEntryGapPct.SCALP);
  if (entry === null) {
    plan.reasons.push("ENTRY_NOT_AT_MARKET");
    return plan;
  }

  // R = k * ATR14 pada bar sinyal (spek §4); SL = entry -/+ 1.0R. Band S-04
  // validate-only: SL tidak pernah digeser (geometri R ditetapkan spek).
  const atr = gate.atr14!;
  const rDistanceSpec = MRV_K * atr;
  const slRaw = side === "LONG" ? entry - rDistanceSpec : entry + rDistanceSpec;
  const slAtrPct = entry > 0 ? atr / entry : null;
  const sl = clampSlToBand(entry, slRaw, side, ctx.mode, slAtrPct, spec.id);
  if (sl.clamped === "INVALID") {
    plan.reasons.push("MRV_SL_OUT_OF_BAND");
    return plan;
  }

  const tgt = buildTargets(entry, sl.sl, side, ctx.mode, spec.id, ctx.tp1ROverride);
  plan.matched = true;
  plan.side = side;
  plan.entryPrice = entry;
  plan.slPrice = sl.sl;
  plan.slPct = sl.slPct;
  plan.slAtrPct = slAtrPct;
  plan.tp1Price = tgt.tp1;
  plan.rDistance = tgt.rDistance;

  // Skor kualitas deterministik (bukan gate): kedalaman RSI2 ekstrem + bias MTF.
  const rsi2 = gate.rsi2!;
  const rsiExtremity = side === "LONG"
    ? clamp(15 - rsi2, 0, 15)
    : clamp(rsi2 - 85, 0, 15);
  plan.quality = clamp(
    Math.round(55 + rsiExtremity + (ctx.analysis.biasAligned ? 10 : 0)),
    0,
    100
  );
  plan.reasons.push(
    ...gate.reasons,
    `MRV_R_${MRV_K}x_ATR14_${round8(atr)}`,
    `MRV_SL_${MRV_K}R_${round8(sl.sl)}`,
    `MRV_TP_${rrPolicyForMode(ctx.mode, spec.id, ctx.tp1ROverride).tp1R}R_${round8(tgt.tp1)}`
  );
  return validatePlan(plan, entry);
}


/**
 * S-05 Swing Breakout Pattern (SWING) — 13 Okt 2026 (perintah operator:
 * "Swing semua untuk Live trading dan paper mode backtest di website").
 *
 * Sinyal dari mesin port 1:1 v2_breakout.py (swingBreakoutEngine.ts, paritas
 * T-04: 877 sinyal Python identik): channel pivot konvergen di bar 1h yang
 * SUDAH TUTUP, entry MARKET saat close menembus garis channel. SL struktural
 * = garis berlawanan x SWING_SL_MULT (konvensi riset sim4, band VALIDATE-ONLY
 * — tidak pernah digeser). SWING RR23: tp1Price = 2R (50%); TP2/final = 3R
 * (50%, tanpa runner), BE setelah TP1; level dikelola Supervisor eksekusi.
 *
 * Fail-closed: tanpa ctx.swing.h1Bars (>= SWING_WARMUP bar tertutup) atau
 * tanpa sinyal pada bar 1h terakhir -> plan TIDAK matched. Mode selain SWING
 * -> MODE_NOT_SWING (S-05 tidak pernah menembak di SCALP).
 */
export function evaluateSwingBreakout(ctx: StrategyContext): StrategyPlan {
  // 20 Okt 2026 (perintah operator: "polaris hapus juga / yang S-05 itu") —
  // S-05 DIHAPUS dari katalog aktif (bukti: master_v2 executed PF 0.7503,
  // P(EV<=0)=99.9%, 2026 PF 0.452 = edge negatif). Plan S-05 harus retired
  // fail-closed: TIDAK crash (spec null), TIDAK ada level harga karangan.
  // Pola sama dengan S-03/S-04 (AU1-02).
  const spec = getStrategySpec("S-05");
  if (!spec) return retiredSwingBreakoutPlan(ctx);
  return evaluateSwingBreakoutWithSpec(ctx, spec);
}

/**
 * Plan retired S-05 untuk jalur ENTRY: matched=false, alasan STRATEGY_RETIRED,
 * tanpa level harga karangan. Dipakai saat S-05 tak ada di katalog aktif.
 */
export function retiredSwingBreakoutPlan(ctx: StrategyContext): StrategyPlan {
  return {
    strategyId: "S-05",
    strategyName: "Swing Breakout Pattern",
    mode: ctx.mode,
    matched: false,
    side: ctx.analysis.side,
    entryType: "MARKET_BREAKOUT",
    entryPrice: 0,
    slPrice: 0,
    tp1Price: 0,
    slPct: 0,
    rDistance: 0,
    rr1: 0,
    quality: 0,
    zoneType: null,
    zoneTop: null,
    zoneBottom: null,
    zoneScore: 0,
    slBasis: "STRUCTURE_INVALIDATION",
    tpBasis: "STRUCTURE_TARGET",
    reasons: ["STRATEGY_RETIRED"],
    tfSummary: "S-05 retired 20 Okt 2026",
  } satisfies StrategyPlan;
}

/**
 * Evaluator ARSIP S-05 (replay historis offline). Memakai spec S-05 dari peta
 * arsip sehingga mesin swingBreakoutEngine tetap bisa dihitung DI LUAR katalog
 * aktif. TIDAK PERNAH dipakai untuk entry — hanya historicalReplay.ts
 * (backtest offline; operator akan meracik backtest dari strategi lain).
 */
export function evaluateSwingBreakoutArchive(ctx: StrategyContext): StrategyPlan {
  const spec = getStrategySpec("S-05") ?? ARCHIVE_SWING_BREAKOUT_SPEC;
  return evaluateSwingBreakoutWithSpec(ctx, spec);
}

function evaluateSwingBreakoutWithSpec(ctx: StrategyContext, spec: StrategySpec): StrategyPlan {
  const plan = basePlan(spec, ctx, ctx.analysis.side, "MARKET_BREAKOUT");
  if (ctx.mode !== "SWING") {
    plan.reasons.push("MODE_NOT_SWING");
    return plan;
  }
  const h1 = ctx.swing?.h1Bars ?? [];
  // Anti-lookahead: mesin hanya menerima bar yang SUDAH TUTUP; pemanggil live
  // memotong bar berjalan sebelum menyusun ctx (T-06 funnel). Warmup mesin
  // (pivot 5+5 + scan 120) wajib terpenuhi sebelum sinyal dianggap sah.
  if (h1.length < SWING_WARMUP) {
    plan.reasons.push(`SWING_NO_DATA:${h1.length}`);
    return plan;
  }
  const sig = latestSwingBreakoutSignal(h1, {
    ...(ctx.swing?.volContrThresh !== undefined ? { volContrThresh: ctx.swing.volContrThresh } : {}),
    ...(ctx.swing?.slMult !== undefined ? { slMult: ctx.swing.slMult } : {}),
  });
  if (!sig) {
    plan.reasons.push("SWING_NO_SIGNAL_ON_LAST_CLOSED_H1");
    return plan;
  }
  const side: Side = sig.side;

  // Entry MARKET di harga live (fill konvensi riset: close bar sinyal; gap
  // live-vs-close dibatasi maxEntryGapPct.SWING anti fill "ajaib" di harga jauh).
  const entry = resolveEntry(ctx, sig.entry, SETUP_ENGINE.maxEntryGapPct.SWING);
  if (entry === null) {
    plan.reasons.push("ENTRY_NOT_AT_MARKET");
    return plan;
  }

  // SL struktural mesin (garis berlawanan x2), validate-only: di luar band
  // sanity -> plan ditolak (SWING_SL_OUT_OF_BAND), TIDAK di-clamp.
  const slRaw = sig.sl;
  const slAtrPct = entry > 0 ? Math.abs(entry - sig.opposite) / entry : null;
  const sl = clampSlToBand(entry, slRaw, side, ctx.mode, slAtrPct, spec.id);
  if (sl.clamped === "INVALID") {
    plan.reasons.push("SWING_SL_OUT_OF_BAND", `SWING_SLPCT_${(sl.slPct * 100).toFixed(2)}pct`);
    return plan;
  }

  const tgt = buildTargets(entry, sl.sl, side, ctx.mode, spec.id, ctx.tp1ROverride);
  plan.matched = true;
  plan.side = side;
  plan.entryPrice = entry;
  plan.slPrice = sl.sl;
  plan.slPct = sl.slPct;
  plan.slAtrPct = slAtrPct;
  plan.tp1Price = tgt.tp1;
  plan.rDistance = tgt.rDistance;

  // Skor kualitas deterministik (bukan gate): kekuatan breakout = rasio
  // penembusan terhadap lebar channel + konvergensi + bias MTF searah.
  const chW = Math.abs(sig.channelWidth) || 1;
  const boundary = side === "LONG"
    ? sig.upper.y1 + ((sig.upper.y2 - sig.upper.y1) * (sig.index - sig.upper.x1)) / (sig.upper.x2 - sig.upper.x1 || 1)
    : sig.lower.y1 + ((sig.lower.y2 - sig.lower.y1) * (sig.index - sig.lower.x1)) / (sig.lower.x2 - sig.lower.x1 || 1);
  const breakoutStrength = chW > 0 ? clamp(Math.abs(entry - boundary) / chW, 0, 1) : 0;
  plan.quality = clamp(
    Math.round(50 + breakoutStrength * 25 + sig.conv * 250 + (ctx.analysis.biasAligned ? 10 : 0)),
    0,
    100
  );
  plan.reasons.push(
    "SWING_CH_CONV_" + (sig.conv * 100).toFixed(1) + "pct",
    `SWING_SL_X${SWING_SL_MULT}_${round8(sl.sl)}`,
    `SWING_TP1_${rrPolicyForMode(ctx.mode, spec.id, ctx.tp1ROverride).tp1R.toFixed(3)}R_${round8(tgt.tp1)}`,
    "SWING_50_2R_BE_50_3R"
  );
  return validatePlan(plan, entry);
}


/**
 * Allowlist strategi aktif (RENUMBER 6 Okt 2026 — SCALP; +SWING 13 Okt 2026;
 * dibersihkan 20–21 Okt 2026):
 *   SCALP = S-02 Liquidity Sniper. S-01 Liquidity Sweep Reclaim ada di
 *           katalog tapi hard-gated (EV negatif, bukan entry source);
 *           S-03 Fibonacci + S-04 Mean-Reversion Stretch DIHAPUS 20 Okt 2026.
 *   SWING = RSW-01 Orion, RSW-02 Vega, RSW-03 Draco. S-05 Swing Breakout
 *           Pattern (Polaris) entry retired 20 Okt 2026 dan diarsipkan
 *           21 Okt 2026 — hanya replay historis, bukan entry source.
 * Allowlist dibaca dari env (SCALP_STRATEGY_IDS / SWING_STRATEGY_IDS) lewat
 * slotFillPolicy.allowedStrategiesFor -> scalpCatalog/swingCatalog.
 * Strategi lama (Squeeze Breakout / FVG Continuation / HA Smooth Scalper /
 * ORB & freeze, S-06) dihapus dari katalog; riwayat trade lama tetap terbaca
 * lewat strategyDisplayName (lihat strategyCatalog.ts). Bila allowlist diisi,
 * strategi di luar daftar tidak dievaluasi (audit: matched=false, reasons
 * NOT_IN_ALLOWLIST).
 */
export function buildStrategyPlans(ctx: StrategyContext, now = Date.now(), allowedIds?: string[]): StrategyPlan[] {
  const build = ctx.mode === "SWING" ? buildSwingStrategyPlans : buildScalpStrategyPlans;
  const plans = build(ctx, now, allowedIds ?? STRATEGY_SPECS.filter((spec) => spec.mode === ctx.mode).map((spec) => spec.id));
  // Retain diagnostic placeholders for excluded strategies without evaluating them in the wrong lane.
  for (const spec of STRATEGY_SPECS) {
    if (!plans.some((plan) => plan.strategyId === spec.id)) {
      const skipped = basePlan(spec, ctx, ctx.analysis.side, "MARKET_BREAKOUT");
      if (spec.mode !== ctx.mode) skipped.reasons.push(`MODE_NOT_${spec.mode}`);
      if (!allowedIds || !allowedIds.includes(spec.id)) skipped.reasons.push("NOT_IN_ALLOWLIST");
      plans.push(skipped);
    }
  }
  // PERINTAH OPERATOR 20 Okt 2026: strategi SCALP (S-01/S-02) TIDAK BOLEH
  // jadi entry source di lane SWING, dan sebaliknya (SWING RSW-* tidak boleh
  // tembak di lane SCALP). Pemisahan lane dijaga di allowlist per-mode, tapi
  // penjaga kedua di sini supaya kebocoran mode MUSTAHIL terjadi walau ada
  // allowlist/env yang salah set — placeholder lintas-mode tetap boleh MUNCUL
  // untuk audit (matched=false + MODE_NOT_*), tapi TIDAK PERNAH boleh match.
  for (const plan of plans) {
    const spec = STRATEGY_SPECS.find((sp) => sp.id === plan.strategyId);
    if (!spec || spec.mode === ctx.mode) continue;
    if (plan.matched) {
      plan.matched = false;
      plan.reasons.push(`MODE_NOT_${spec.mode}`);
    }
  }
  return plans.sort((a, b) => Number(b.matched) - Number(a.matched) || b.quality - a.quality);
}

export async function selectBestPlan(ctx: StrategyContext, now = Date.now(), allowedIds?: string[]): Promise<{ plan: StrategyPlan | null; all: StrategyPlan[] }> {
  const all = buildStrategyPlans(ctx, now, allowedIds);
  // A trend direction alone is not an entry trigger; require one of S-01/S-02/S-03.
  let best = all.find((p) => p.matched) ?? null;

  // 27 Okt 2026: AI Council DIPINDAH dari level scan ini ke funnel entry
  // (tepat sebelum executePlannedEntry di autonomousTradingBot.ts) — di sini
  // council dipanggil untuk SETIAP plan cocok (~61x/menit x 3 agen) yang
  // membanjiri provider LLM dan mem-veto 100% entry. Lihat runPreEntryCouncil
  // di agents/councilEngine.ts.
  return { plan: best, all };
}

export const ALL_STRATEGY_IDS = [...new Set(STRATEGY_SPECS.map((s) => s.id))];





