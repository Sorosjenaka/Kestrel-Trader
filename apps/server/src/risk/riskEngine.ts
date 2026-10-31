// apps/server/src/risk/riskEngine.ts - Risk Engine: Sizing $1, Margin Cap 40%, MinNotional, Liquidation Guard (FR-15, FR-16, NFR-13, US-06).
import { checkAssetClass } from "../universe/assetClassGuard.js";
import { rrPolicyForMode, type SetupMode } from "../config/setupEngine.js";
import { SETUP_ENGINE } from "../config/setupEngine.js";
import { TAKER_RATE } from "../config/costs.js";
import { swingLadderLevelsFromTp1 } from "../strategies/swing/swingLevels.js";

export type OrderSide = "BUY" | "SELL";
export type PositionDirection = "LONG" | "SHORT";

export interface SymbolRiskRules {
  symbol: string;
  minNotional: number; // e.g. 5.0 USD
  tickSize: number;    // e.g. 0.01
  stepSize: number;    // e.g. 0.001
  minQty?: number;
  maxQty?: number;
  maxLeverage: number; // Binance bracket max leverage (e.g. 20, 50, 75)
  leverageUpdatedAt: number | null; // Timestamp snapshot max leverage
  isBlacklisted?: boolean;
  blacklistReason?: string | null;
}

export interface RiskSizingInput {
  symbol: string;
  /** SCALP is retained as the default for older callers; trading lanes pass this explicitly. */
  mode?: SetupMode;
  strategyId?: string;
  /** Explicit replay-only override; live callers use the active gated version. */
  tp1ROverride?: number;
  side: OrderSide | PositionDirection;
  entryPrice: number;
  slPrice: number;
  tp1Price?: number;
  equityUsd: number;
  targetRiskUsd?: number; // default $1.00 (Rules §4)
  marginCapPct?: number;  // default 0.40 (40% equity)
  leverageTarget?: number;
  marginMode?: "CROSS" | "ISOLATED";
  riskBudgetMode?: "GROSS" | "NET";
  entryFeeRate?: number;
  exitFeeRate?: number;
  slippageBps?: number;
  requestedQty?: number;
  maxMarginUsd?: number;
  allowStepOverhang?: boolean;
  symbolRules: SymbolRiskRules;
  now?: number;
}

export interface OrderPlan {
  symbol: string;
  side: PositionDirection;
  entryPrice: number;
  slPrice: number;
  tp1Price: number;
  tp2Price: number;
  qty: number;
  notionalUsd: number;
  marginUsd: number;
  leverage: number;
  effectiveRiskUsd: number;
  estimatedNetRiskUsd: number;
  estimatedFeesUsd: number;
  riskReductionRatio: number;
  estLiqPrice: number;
  liqDistancePct: number;
  slDistancePct: number;
  allowed: boolean;
  rejectReason: string | null;
}

export const DEFAULT_RISK_USD = 1.00;
export const DEFAULT_MARGIN_CAP_PCT = 0.40;
export const MAX_LEVERAGE_SYSTEM = 25;
/** Conservative order-entry sizing assumption, not a guaranteed stop fill. */
export const AUTO_STOP_GAP_BPS = 60;
export const MAX_LEVERAGE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Alokasi margin SCALP-only; sizing akhir tetap dibatasi estimasi risiko net $1.
// Perintah operator 25 Sep 2026: modal awal diperbesar $20 -> $200.
// 15 Okt 2026 — perintah operator: modal paper diatur lewat env
// PAPER_START_EQUITY_USD (default tetap $200 tanpa env).
export const START_EQUITY_USD = (() => {
  const v = Number(process.env.PAPER_START_EQUITY_USD);
  return Number.isFinite(v) && v > 0 ? v : 200.0;
})();
// 30 Sep 2026 — refactor SCALP-only: lantai alokasi mode lama dihapus.
export const SCALP_MAX_MARGIN_USD = 4.8; // $4.00 +20%; plafon, bukan target yang dipaksa.
// 13 Okt 2026 (S-05 Swing Breakout): SL struktural median 4.74% (p5 1.24%) pada
// risiko $1 => notional ~ $21; leverage efektif ~5x => margin ~ $4.20. Plafon $8
// memberi ruang aman utk SL ekstrem (cap band 20% => notional maks $5 risiko penuh
// — jauh di bawah). SCALP tidak tersentuh.
// 14 Okt 2026 — perintah operator: "max margin $2, perbaiki logika penempatan
// SL" (kasus MAGMAUSDT: SL fib 0.75% -> notional $133 -> margin $6.65 dipandang
// tidak logis utk swing). Plafon margin SWING turun $8 -> $2. Dengan SL swing
// yang sehat (>= 1.2%, median 4.7%), notional $21-$83 di 25x tetap muat.
export const SWING_MAX_MARGIN_USD = 2;

/**
 * 27 Okt 2026: cap atas SL mode SWING per strategi.
 *
 * Sumber tunggal = SETUP_ENGINE (config), supaya riskEngine & setupEngine
 * tidak bisa berbeda angka.
 *   - Entry source AKTIF (RSW-01/02/03): SWING_SL_BAND_MAX = 6%. Angka ini
 *     diturunkan dari data terukur trio RSW di master_v2 (max SL 5,9967% s/d
 *     5,9984% dari 20.014 sinyal) — 6% adalah batas yang tidak bisa dilampaui
 *     mesin strategi (rswSignals.ts:373,531 sudah hard-cap 6%).
 *   - Arsip S-05 "Polaris" (non-entry; hanya historicalReplay + worker paper
 *     Polaris): SWING_ARCHIVE_SL_BAND_MAX = 20%. Geometri SL-nya sendiri
 *     (garis berlawanan x2) jauh lebih lebar — fixture terukur 2,16% s/d 18,74%.
 *     Pakai cap ketat 6% di sini = 57,87% sinyal arsip terbuang; arsip tidak
 *     boleh makin sempit.
 */
export function swingSlBandMaxFor(strategyId?: string | null): number {
  if (strategyId && String(strategyId).toUpperCase() === "S-05") {
    return SETUP_ENGINE.SWING_ARCHIVE_SL_BAND_MAX;
  }
  return SETUP_ENGINE.SWING_SL_BAND_MAX;
}

// 11 Okt 2026 — perintah operator: "scalp margin buat maksimal 3$ di live futures".
// Plafon margin per posisi saat mode LIVE; PAPER tetap memakai SCALP_MAX_MARGIN_USD.
// (Dibaca dari process.env seperti factory dailyGuard — tanpa siklus import.)
export function maxMarginForMode(mode: "SCALP" | "SWING" = "SCALP"): number {
  // 13 Okt 2026: SWING (S-05) memakai plafon margin sendiri ($8, lihat
  // SWING_MAX_MARGIN_USD) — SL struktural 1h median 4.7% butuh notional lebih
  // besar pada risiko $1. LIVE tetap hormati LIVE_MAX_MARGIN_USD.
  const isLive = String(process.env.BINANCE_EXECUTION_MODE ?? "PAPER").trim().toUpperCase() === "LIVE";
  if (mode === "SWING") {
    const liveCap = Number(process.env.LIVE_MAX_MARGIN_USD ?? 3);
    return isLive && Number.isFinite(liveCap) && liveCap > 0
      ? Math.min(SWING_MAX_MARGIN_USD, liveCap)
      : SWING_MAX_MARGIN_USD;
  }
  const liveCap = Number(process.env.LIVE_MAX_MARGIN_USD ?? 3);
  return isLive && Number.isFinite(liveCap) && liveCap > 0
    ? Math.min(SCALP_MAX_MARGIN_USD, liveCap)
    : SCALP_MAX_MARGIN_USD;
}
// Ambang kesehatan equity diskalakan dari modal awal (90% "healthy" / 75% "watch").
export const EQUITY_HEALTHY_USD = Number((START_EQUITY_USD * 0.9).toFixed(2));
export const EQUITY_WATCH_USD = Number((START_EQUITY_USD * 0.75).toFixed(2));

export function getPrecision(val: number): number {
  const str = val.toString();
  if (str.includes("e-")) {
    const parts = str.split("e-");
    return Number(parts[1]) || 0;
  }
  const dec = str.split(".")[1];
  return dec ? dec.length : 0;
}

export function quantizeStep(val: number, step: number, direction: "floor" | "ceil" | "round" = "floor"): number {
  if (step <= 0) return val;
  const precision = getPrecision(step);
  const steps = direction === "ceil"
    ? Math.ceil(val / step - 1e-9)
    : direction === "round"
    ? Math.round(val / step)
    : Math.floor(val / step + 1e-9);
  const quantized = steps * step;
  return Number(quantized.toFixed(precision));
}

export function roundToTick(val: number, tick: number): number {
  if (tick <= 0) return val;
  const precision = getPrecision(tick);
  const rounded = Math.round(val / tick) * tick;
  return Number(rounded.toFixed(precision));
}

/**
 * 13 Okt 2026 — LOGIKA SL/TP "lewat leverage" (perintah operator, contoh setup manual
 * USUSDT SHORT qty 2158 @ 0.013944: SL 0.014407 = risk $1.00, TP 0.013156 = profit $1.70):
 *   qty sudah ditentukan margin/leverage -> jarak SL = RISK_USD / qty, jarak TP = TP_USD / qty.
 * BUKAN jarak SL dari struktur strategi (bug 13 Okt: SL jarak strategi -> risk cuma $0.52).
 * Pembulatan ke tick TIDAK BOLEH melewati nominal: SL distance di-floor (risk <= $1),
 * TP distance di-floor (profit tidak diklaim lebih dari $1.7).
 */
export function fixedRiskLevels(input: {
  entryPrice: number; qty: number; side: PositionDirection;
  tickSize: number; riskUsd?: number; tpUsd?: number;
}): { slPrice: number; tpPrice: number; riskUsd: number; tpUsd: number } {
  const riskBudget = input.riskUsd ?? DEFAULT_RISK_USD;
  const tpBudget = input.tpUsd ?? DEFAULT_RISK_USD * 1.7;
  const { entryPrice: E, qty, tickSize } = input;
  if (!(Number.isFinite(E) && E > 0) || !(qty > 0) || !(tickSize > 0) || !(riskBudget > 0) || !(tpBudget > 0)) {
    throw new Error("FIXED_LEVELS_INPUT_INVALID");
  }
  const long = input.side === "LONG";
  // Jarak harga per unit agar loss tepat $1 / profit tepat $1.7 pada qty final.
  // SL distance di-FLOOR: pembulatan tick tidak boleh membuat risk melewati $1.
  const tick = input.tickSize;
  let slDist = quantizeStep(riskBudget / qty, tick, "floor");
  const tpDist = roundToTick(tpBudget / qty, tick);
  if (!(slDist > 0) || !(tpDist > 0)) throw new Error("FIXED_LEVELS_DISTANCE_ZERO");
  // E bisa belum kelipatan tick (mark price live) — harga SL dibulatkan ke tick,
  // jarak efektifnya bisa bergeser setengah tick. Clamp: kurangi 1 tick bila risk > budget.
  let slPrice = roundToTick(long ? E - slDist : E + slDist, tick);
  let riskUsd = Number((qty * Math.abs(E - slPrice)).toFixed(6));
  let guard = 0;
  while (riskUsd > riskBudget + 1e-9 && slDist > tick && guard++ < 5) {
    slDist = Number((slDist - tick).toFixed(12));
    slPrice = roundToTick(long ? E - slDist : E + slDist, tick);
    riskUsd = Number((qty * Math.abs(E - slPrice)).toFixed(6));
  }
  if (riskUsd > riskBudget + 1e-6) throw new Error("FIXED_LEVELS_RISK_OVER_BUDGET");
  const tpPrice = roundToTick(long ? E + tpDist : E - tpDist, tick);
  const tpUsd = Number((qty * Math.abs(tpPrice - E)).toFixed(6));
  return { slPrice, tpPrice, riskUsd, tpUsd };
}

/**
 * 13 Okt 2026 (revisi 2) — Perintah operator: "margin jangan FLAT set 3$, itu
 * batasan MAKSIMAL penggunaan". Sizing berbasis risiko struktur:
 *   qty = $1 ÷ jarak SL struktur  -> risk pas $1, SL tepat di level invalidasi
 *   (fixedRiskLevels lalu menurunkan SL/TP dari qty ini).
 * Margin adalah AKIBAT (qty×harga÷leverage), bukan target: leverage otomatis
 * dinaikkan (maks 25x / maks simbol) supaya margin ≤ plafon. Bila leverage
 * maksimal simbol tetap tidak cukup, qty dipotong sampai margin = plafon.
 */
export function structuralRiskSizing(input: {
  entryPrice: number;
  structuralSlPrice: number;
  stepSize: number;
  targetRiskUsd?: number;
  marginCapUsd: number;
  maxLeverage: number;
  leverageTarget?: number;
  maxQty?: number;
  /** SWING (15 Okt 2026, perintah operator): risk SL wajib di band $1–$1.2. */
  enforceRiskBand?: boolean;
}): { ok: true; qty: number; leverage: number; marginUsd: number; notionalUsd: number; riskAtStructureUsd: number }
  | { ok: false; reason: string } {
  const E = input.entryPrice;
  const targetRisk = input.targetRiskUsd ?? DEFAULT_RISK_USD;
  const structDist = Math.abs(E - input.structuralSlPrice);
  if (!(Number.isFinite(E) && E > 0) || !(structDist > 0) || !(input.stepSize > 0)) {
    return { ok: false, reason: "SIZING_INPUT_INVALID" };
  }
  if (!(input.marginCapUsd > 0) || !Number.isFinite(input.marginCapUsd)) {
    return { ok: false, reason: "MARGIN_CAP_INVALID" };
  }
  const levMax = Math.max(1, Math.floor(Math.min(MAX_LEVERAGE_SYSTEM, input.maxLeverage)));
  // qty dari risiko struktur: SL = level invalidasi strategi, risk = tepat $1.
  const qtyRisk = targetRisk / structDist;
  // 14 Okt 2026 (perintah operator): leverage DIPATOK 25x semua mode (maks
  // simbol tetap dihormati) — margin = notional/25, tidak lagi otomatis dicari
  // agar muat plafon. Bila margin tetap lewat plafon, qty dipotong di bawah.
  const leverage = levMax;
  // 15 Okt 2026 (perintah operator, ATURAN SWING): risk SL per trade wajib di
  // band $1–$1.2 — di bawah $1 TIDAK diterima (hard floor). Jarak SL lebar ->
  // qty/margin DISESUAIKAN TURUN sebelum entry limit dipasang (risk = qty ×
  // jarak SL tetap di band); JANGAN PERNAH menaikkan margin demi capai floor.
  const bandMaxRisk = input.enforceRiskBand ? targetRisk * 1.2 : targetRisk;
  const pickQty = (idealQty: number): number => {
    const qFloor = quantizeStep(idealQty, input.stepSize, "floor");
    if (!input.enforceRiskBand) return qFloor;
    const rFloor = qFloor * structDist;
    if (rFloor >= targetRisk - 1e-9) return qFloor; // floor sudah >= $1
    // floor di bawah $1 -> naikkan satu step; terima hanya bila <= $1.2
    const qCeil = quantizeStep(idealQty, input.stepSize, "ceil");
    if (qCeil * structDist <= bandMaxRisk + 1e-9) return qCeil;
    return qFloor; // step terlalu kasar utk band -> biarkan floor, reject di bawah
  };
  let qty = pickQty(qtyRisk);
  if (input.maxQty !== undefined && qty > input.maxQty) {
    // maxQty lebih kecil dari kebutuhan risk $1 -> hard floor terlanggar.
    qty = quantizeStep(input.maxQty, input.stepSize, "floor");
  }
  // Margin = akibat. Bila masih melebihi plafon walau leverage sudah maks,
  // potong qty sampai margin = plafon (risk jadi < $1 pada SL struktur; SL
  // tetap $1 pada jarak baru via fixedRiskLevels).
  if ((qty * E) / leverage > input.marginCapUsd + 1e-9) {
    // Mode band (SWING): memotong qty = risk di bawah $1 = tidak diterima.
    // Entry DITOLAK (fail-closed) alih-alih menerima risk kecil. Margin tidak
    // pernah dinaikkan — jarak SL lebar justru membuat margin otomatis kecil.
    if (input.enforceRiskBand) return { ok: false, reason: "RISK_FLOOR_MARGIN_CAP" };
    qty = quantizeStep((input.marginCapUsd * leverage) / E, input.stepSize, "floor");
  }
  if (!(qty > 0)) return { ok: false, reason: "QTY_ZERO" };
  const finalRisk = qty * structDist;
  if (input.enforceRiskBand && finalRisk < targetRisk - 1e-9) {
    // Hard floor operator: risk di bawah $1 tidak diterima (maxQty terlalu
    // kecil / step terlalu kasar) — tolak entry, jangan kecilkan risk diam-diam.
    return { ok: false, reason: "RISK_BELOW_FLOOR" };
  }
  const notionalUsd = qty * E;
  const marginUsd = notionalUsd / leverage;
  if (marginUsd > input.marginCapUsd + 1e-9) return { ok: false, reason: "MARGIN_OVER_CAP" };
  return { ok: true, qty, leverage, marginUsd, notionalUsd, riskAtStructureUsd: qty * structDist };
}

/** Prices are finalized before sizing. Fees/slippage are estimates, never a loss guarantee. */
export function calculateOrderPlan(input: RiskSizingInput): OrderPlan {
  const now = input.now ?? Date.now();
  const targetRisk = input.targetRiskUsd ?? DEFAULT_RISK_USD;
  const marginCapPct = input.marginCapPct ?? DEFAULT_MARGIN_CAP_PCT;
  const rules = input.symbolRules;
  const side: PositionDirection = input.side === "BUY" || input.side === "LONG" ? "LONG" : "SHORT";
  const reject = (rejectReason: string): OrderPlan => ({
    symbol: rules.symbol, side, entryPrice: input.entryPrice, slPrice: input.slPrice,
    tp1Price: input.tp1Price ?? 0, tp2Price: input.tp1Price ?? 0,
    qty: 0, notionalUsd: 0, marginUsd: 0, leverage: 1, effectiveRiskUsd: 0,
    estimatedNetRiskUsd: 0, estimatedFeesUsd: 0, riskReductionRatio: 0,
    estLiqPrice: 0, liqDistancePct: 0, slDistancePct: 0, allowed: false, rejectReason,
  });
  const positive = (n: number) => Number.isFinite(n) && n > 0;
  if (!["BUY", "SELL", "LONG", "SHORT"].includes(input.side)) return reject("INVALID_SIDE");
  // 30 Sep 2026 — refactor SCALP-only: hanya mode SCALP yang valid.
  // 13 Okt 2026: mode SWING (S-05 Swing Breakout) kembali valid.
  if (input.mode !== undefined && !["SCALP", "SWING"].includes(input.mode)) return reject("INVALID_MODE");
  const rrPolicy = rrPolicyForMode(input.mode ?? "SCALP", input.strategyId, input.tp1ROverride);
  const asset = checkAssetClass(input.symbol);
  if (asset.blocked) return reject(asset.reason ?? "NON_CRYPTO_ASSET_BLOCKED");
  if (rules.isBlacklisted) return reject("SYMBOL_BLACKLISTED");
  if (input.symbol !== rules.symbol) return reject("SYMBOL_RULES_MISMATCH");
  if (!positive(input.entryPrice) || !positive(input.slPrice)) return reject("INVALID_PRICE");
  if (!positive(input.equityUsd)) return reject("INSUFFICIENT_EQUITY");
  if (!positive(targetRisk) || targetRisk > DEFAULT_RISK_USD) return reject("INVALID_RISK_BUDGET");
  if (!positive(marginCapPct) || marginCapPct > DEFAULT_MARGIN_CAP_PCT) return reject("INVALID_MARGIN_CAP");
  if (!positive(rules.tickSize) || !positive(rules.stepSize) || !positive(rules.minNotional)
      || (rules.minQty !== undefined && !positive(rules.minQty))
      || (rules.maxQty !== undefined && !positive(rules.maxQty))) return reject("INVALID_SYMBOL_FILTERS");
  if (!positive(rules.maxLeverage) || !Number.isInteger(rules.maxLeverage)
      || !rules.leverageUpdatedAt || !Number.isFinite(rules.leverageUpdatedAt)) return reject("LEVERAGE_NOT_FOUND");
  if (!Number.isFinite(now) || rules.leverageUpdatedAt > now + 60_000
      || now - rules.leverageUpdatedAt > MAX_LEVERAGE_AGE_MS) return reject("STALE_LEVERAGE_SNAPSHOT");
  const requestedLev = input.leverageTarget ?? MAX_LEVERAGE_SYSTEM;
  // 14 Okt 2026 (perintah operator): leverage 25x SEMUA mode termasuk SWING
  // (dulu SWING dibatasi 5x). Cap margin & jarak likuidasi tetap divalidasi
  // LIQUIDATION_TOO_CLOSE di bawah — fail-closed bila SL menempel likuidasi.
  const levCap = MAX_LEVERAGE_SYSTEM;
  if (!positive(requestedLev) || !Number.isInteger(requestedLev)) return reject("INVALID_LEVERAGE");
  const leverage = Math.min(MAX_LEVERAGE_SYSTEM, levCap, rules.maxLeverage, requestedLev);
  const E = input.entryPrice;
  const isLong = side === "LONG";
  if (isLong ? input.slPrice >= E : input.slPrice <= E) return reject(`INVALID_SL_DIRECTION_${side}`);
  // Round SL away from entry: never move it inside the structural invalidation.
  const grid = (value: number, up: boolean) => Number(((up ? Math.ceil(value / rules.tickSize - 1e-9)
    : Math.floor(value / rules.tickSize + 1e-9)) * rules.tickSize).toFixed(getPrecision(rules.tickSize)));
  const slPrice = grid(input.slPrice, !isLong);
  if (!positive(slPrice) || (isLong ? slPrice >= E : slPrice <= E)) return reject(`INVALID_SL_DIRECTION_${side}`);
  const rDistance = Math.abs(E - slPrice);
  const slDistancePct = rDistance / E;
  if (slDistancePct <= 0.0001) return reject("SL_TOO_TIGHT");
  // 13 Okt 2026 (S-05): SL struktural bar 1h median 4.74% (p5 1.24%) — cap 2.5%
  // SCALP akan menolak majority sinyal tervalidasi. Cap SWING = 6% (27 Okt 2026,
  // diturunkan dari 20% ke batas terukur trio RSW: max SL 5,9967%-5,9984% di
  // master_v2 n=20.014 sinyal; 0 sinyal melewati 6%). Arsip S-05 (non-entry,
  // replay historis) memakai band TERPISAH 20% karena geometri SL-nya (garis
  // berlawanan x2) jauh lebih lebar — lihat SETUP_ENGINE.SWING_ARCHIVE_SL_BAND_MAX.
  const maxSlPct = input.mode === "SWING"
    ? swingSlBandMaxFor(input.strategyId)
    : 0.025;
  // 27 Okt 2026: toleransi tick (khusus mode SWING). SL struktural di-grid ke
  // tick symbol (round AWAY dari entry) sehingga % SL bisa naik sedikit di atas
  // cap — itu artefak pembulatan harga, bukan SL yang benar-benar lebih lebar.
  // Tanpa toleransi ini, 10 dari 20.014 sinyal RSW (0,05%) ditolak palsu
  // (deviasi maks 0,0565pp < tick/E 0,0904pp; 1 di antaranya executed).
  // SCALP SENGAJA TIDAK diberi toleransi — perilakunya tidak boleh berubah.
  const slCapTolerance = input.mode === "SWING"
    ? Math.max(rules.tickSize / E, SETUP_ENGINE.SWING_SL_CAP_TOLERANCE_PCT)
    : 0;
  if (slDistancePct > maxSlPct + slCapTolerance + 1e-12) return reject("SL_EXCEEDS_MAX");
  const sign = isLong ? 1 : -1;
  const tp1Price = grid(E + sign * rrPolicy.tp1R * rDistance, isLong);
  // SCALP has one target; SWING preview and execution share ladder geometry.
  const tp2Price = input.mode === "SWING"
    ? swingLadderLevelsFromTp1(side, E, tp1Price, true).tp2 : tp1Price;
  if (!positive(tp1Price) || (isLong ? !(E < tp1Price) : !(E > tp1Price))) return reject("INVALID_TP_GEOMETRY");
  const tp1Dist = sign * (tp1Price - E);
  if (Math.abs(tp1Dist - rrPolicy.tp1R * rDistance) > rules.tickSize * 2 + 1e-10) return reject("TP1_R_MISMATCH");
  const entryFeeRate = input.entryFeeRate ?? TAKER_RATE;
  const exitFeeRate = input.exitFeeRate ?? TAKER_RATE;
  const slippageBps = input.slippageBps ?? 0;
  if (![entryFeeRate, exitFeeRate, slippageBps].every(n => Number.isFinite(n) && n >= 0)
      || entryFeeRate >= 1 || exitFeeRate >= 1 || slippageBps >= 10000) return reject("INVALID_COST_MODEL");
  const feesPerUnit = E * entryFeeRate + slPrice * exitFeeRate;
  const slippagePerUnit = E * slippageBps / 10000;
  const netPerUnit = rDistance + feesPerUnit + slippagePerUnit;
  const riskBudgetMode = input.riskBudgetMode ?? "GROSS";
  const riskPerUnit = riskBudgetMode === "GROSS" ? rDistance : netPerUnit;
  const maxMargin = input.maxMarginUsd ?? Infinity;
  if (input.maxMarginUsd !== undefined && !positive(maxMargin)) return reject("INVALID_MARGIN_CAP");
  const marginCapUsd = Math.min(input.equityUsd * marginCapPct, maxMargin);
  if (input.requestedQty !== undefined && !positive(input.requestedQty)) return reject("INVALID_QTY");

  const rawQty = Math.min(targetRisk / riskPerUnit, marginCapUsd * leverage / E,
    rules.maxQty ?? Infinity, input.requestedQty ?? Infinity);
  // RR klasik: target 1R loss = FIX $1.00 — TIDAK PERNAH LEBIH (perintah operator 12 Okt 2026).
  // Overhang 25% (maks $1.25) DIHAPUS: bila ceil melewati $1, qty dibulatkan ke bawah.
  // 11 Okt 2026 — dikembalikan ke 1.25 oleh operator (ambang 1.2 menyebabkan rejection
  // massal di LIVE karena ceil mendorong margin melewati cap $3 pada stepSize besar).
  const wantsOverhang = Boolean(input.allowStepOverhang) && riskBudgetMode === "GROSS" && input.requestedQty === undefined;
  const ceilQty = wantsOverhang ? quantizeStep(rawQty, rules.stepSize, "ceil") : 0;
  // 11 Okt 2026 — FIX: ceil juga harus menghormati margin cap. Tanpa cek ini,
  // ceil membulatkan qty ke atas sehingga margin melewati cap (mis. LUMIAUSDT
  // stepSize 0.1: floor 175.1 margin $2.999 OK, ceil 175.2 margin $3.0006 > $3 REJECT).
  // 12 Okt 2026 — FIX $1: ceil hanya dipakai bila risikonya TETAP <= $1.00.
  const canUseCeil = wantsOverhang && ceilQty * riskPerUnit <= targetRisk + 1e-9
    && (ceilQty * E / leverage) <= marginCapUsd + 1e-9;
  const qty = canUseCeil ? ceilQty : quantizeStep(rawQty, rules.stepSize, "floor");
  const notionalUsd = qty * E, marginUsd = notionalUsd / leverage;
  const effectiveRiskUsd = qty * rDistance, estimatedNetRiskUsd = qty * netPerUnit;
  if (!(qty > 0) || qty < (rules.minQty ?? rules.stepSize)) return reject("QTY_LT_MIN");
  if (notionalUsd < rules.minNotional - 1e-10) return reject("NOTIONAL_LT_MIN");
  // 12 Okt 2026 — FIX $1 (perintah operator): batas absolut TEPAT $1.00 per trade,
  // tidak ada toleransi overhang. Loss di SL tidak akan pernah melewati $1.
  const maxAllowedRisk = targetRisk + 1e-9;
  if (marginUsd > marginCapUsd + 1e-9 || qty * riskPerUnit > maxAllowedRisk) return reject("FINAL_RISK_EXCEEDS_BUDGET");
  // Isolated estimate only; cross liquidation needs authoritative account/bracket data.
  const mmr = 0.01;
  const estLiqPrice = input.marginMode === "CROSS" ? 0 : E * (isLong ? (1 - 1 / leverage) / (1 - mmr) : (1 + 1 / leverage) / (1 + mmr));
  const liqDistancePct = estLiqPrice > 0 ? Math.abs(E - estLiqPrice) / E : 0;
  if (estLiqPrice > 0 && ((isLong ? estLiqPrice >= slPrice : estLiqPrice <= slPrice)
      || liqDistancePct < slDistancePct * 1.1)) return reject("LIQUIDATION_TOO_CLOSE");
  return { symbol: rules.symbol, side, entryPrice: E, slPrice, tp1Price, tp2Price,
    qty, notionalUsd, marginUsd, leverage, effectiveRiskUsd, estimatedNetRiskUsd,
    estimatedFeesUsd: qty * feesPerUnit, riskReductionRatio: qty * riskPerUnit / targetRisk,
    estLiqPrice, liqDistancePct, slDistancePct, allowed: true, rejectReason: null };
}

// Anti-liquidation tingkat akun: batasi total margin terpakai vs equity.
// Isolated-margin per posisi sudah dijaga SL (<=2,5%) + LIQUIDATION_TOO_CLOSE,
// guard ini mencegah over-exposure gabungan yang memicu margin-call beruntun.
export const MARGIN_LEVEL_BLOCK_PCT = 0.7;
export const MARGIN_LEVEL_WARN_PCT = 0.5;

export interface MarginLevelResult {
  equityUsd: number;
  usedMarginUsd: number;
  usedPct: number;
  warn: boolean;
  allowed: boolean;
  reason: string | null;
}

/** Informational pre-trade CROSS liquidation estimate. The venue's maintenance
 * bracket wins; this is intentionally conservative for an admission guard. */
export function estimateCrossLiquidationPrice(
  entryPrice: number,
  side: PositionDirection | string,
  equityUsd: number,
  totalNotionalUsd: number,
  positionNotionalUsd: number,
  mmrRate = 0.01,
): number | null {
  if (!(entryPrice > 0) || !(equityUsd > 0) || !(totalNotionalUsd > 0) || !(positionNotionalUsd > 0)) return null;
  const buffer = equityUsd - mmrRate * totalNotionalUsd;
  if (!(buffer > 0)) return entryPrice;
  const qty = positionNotionalUsd / entryPrice;
  if (!(qty > 0)) return null;
  const maxAdverse = (buffer * positionNotionalUsd) / totalNotionalUsd;
  const distance = maxAdverse / qty;
  if (!Number.isFinite(distance) || distance < 0) return null;
  return Number((side === "LONG" ? entryPrice - distance : entryPrice + distance).toFixed(8));
}

export interface SwingLiquidationCheckInput {
  marginMode?: string;
  side: PositionDirection | string;
  entryPrice: number;
  slPrice: number;
  leverage: number;
  equityUsd: number;
  totalOpenNotionalUsd: number;
  positionNotionalUsd: number;
}
export interface SwingLiquidationCheck {
  allowed: boolean;
  reason: string | null;
  liqPrice: number | null;
  liqDistancePct: number;
}

/** Shared fail-closed SWING admission guard. ISOLATED uses 1/leverage;
 * CROSS uses account equity and total open notional. */
export function checkSwingLiquidation(input: SwingLiquidationCheckInput): SwingLiquidationCheck {
  const slDistancePct = Math.abs(input.entryPrice - input.slPrice) / input.entryPrice;
  if (!(input.entryPrice > 0) || !(input.slPrice > 0) || !(input.leverage > 0) || !(slDistancePct > 0)) {
    return { allowed: false, reason: "INVALID_LIQUIDATION_INPUT", liqPrice: null, liqDistancePct: 0 };
  }
  const mode = String(input.marginMode ?? "CROSS").toUpperCase();
  if (mode === "ISOLATED") {
    return {
      allowed: slDistancePct < (1 / input.leverage) * 0.8,
      reason: slDistancePct < (1 / input.leverage) * 0.8 ? null : "SWING_SL_NEAR_LIQ",
      liqPrice: null,
      liqDistancePct: 0,
    };
  }
  const totalNotional = input.totalOpenNotionalUsd + input.positionNotionalUsd;
  const liqPrice = estimateCrossLiquidationPrice(
    input.entryPrice, input.side, input.equityUsd, totalNotional, input.positionNotionalUsd,
  );
  const liqDistancePct = liqPrice == null ? 0 : Math.abs(input.entryPrice - liqPrice) / input.entryPrice;
  const beforeLiq = liqPrice != null && (input.side === "LONG" ? liqPrice < input.slPrice : liqPrice > input.slPrice);
  const allowed = beforeLiq && liqDistancePct >= slDistancePct * 1.1;
  return { allowed, reason: allowed ? null : "SWING_SL_NEAR_LIQ", liqPrice, liqDistancePct };
}

export function checkMarginLevel(equityUsd: number, usedMarginUsd: number): MarginLevelResult {
  const equity = Number(equityUsd) || 0;
  const used = Math.max(0, Number(usedMarginUsd) || 0);
  const usedPct = equity > 0 ? used / equity : 1;
  if (equity <= 0) {
    return { equityUsd: equity, usedMarginUsd: used, usedPct, warn: true, allowed: false, reason: "MARGIN_LEVEL_NO_EQUITY" };
  }
  if (usedPct >= MARGIN_LEVEL_BLOCK_PCT) {
    return { equityUsd: equity, usedMarginUsd: used, usedPct: Number(usedPct.toFixed(4)), warn: true, allowed: false, reason: "MARGIN_LEVEL_GUARD" };
  }
  return {
    equityUsd: equity,
    usedMarginUsd: used,
    usedPct: Number(usedPct.toFixed(4)),
    warn: usedPct >= MARGIN_LEVEL_WARN_PCT,
    allowed: true,
    reason: null,
  };
}

// 30 Sep 2026 — refactor SCALP-only: hanya satu mode di kode sizing.
export type MarginMode = "SCALP" | "SWING";

export interface MarginPolicyResult {
  mode: MarginMode;
  slPct: number;
  targetRiskUsd: number;
  leverage: number;
  notionalUsd: number;
  marginUsd: number;
  allowed: boolean;
  reason: string | null;
  capped: boolean;
}

// Skor performa untuk SCALP: buru koin top perform (gerak besar + volume besar).
// Dipakai bot + scanner agar setup mudah didapat; filter volume futures dijalankan di hulu.
export function performanceScore(absChg24hPct: number, vol24hUsd: number): number {
  const volTerm = Math.log10(1 + Math.max(0, vol24hUsd) / 1_000_000);
  return Number((Math.max(0, absChg24hPct) * (1 + volTerm)).toFixed(4));
}

// Hash deterministik (bukan Math.random) agar margin variatif tapi reproducible/testable.
function hash01(s: string, salt = ""): number {
  let h = 2166136261;
  const str = `${salt}:${s}`;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

// Kebijakan alokasi per mode: margin aktual = notional / leverage dan dapat
// lebih kecil ketika SL ATR melebar, biaya/slippage mengikat, atau qty dibulatkan.
export function resolveMarginPolicy(input: {
  mode: MarginMode | string;
  equityUsd: number;
  score?: number;
  maxLeverage?: number;
  seed?: string;
  structuralSlPct?: number;
  strategyId?: string;
  /** Tick size symbol — dipakai untuk toleransi pembulatan pada cap SL SWING. */
  tickSize?: number;
  /** Harga entry — pembagi tickSize agar toleransi jadi persentase. */
  entryPrice?: number;
}): MarginPolicyResult {
  const mode: MarginMode = input.mode === "SWING" ? "SWING" : "SCALP";
  const denied = (reason: string): MarginPolicyResult => ({ mode, slPct: 0, targetRiskUsd: 0, leverage: 1, notionalUsd: 0, marginUsd: 0, allowed: false, reason, capped: false });
  if (input.mode !== "SCALP" && input.mode !== "SWING") return denied("INVALID_TRADING_MODE");
  // 27 Okt 2026: cap per strategi (trio RSW 6%; arsip S-05 20%) — helper
  // yang sama dipakai calculateOrderPlan supaya kedua pintu tidak berbeda angka.
  // Toleransi tick: SL struktural di-grid ke tick symbol (round away dari
  // entry) sehingga % SL bisa naik sedikit di atas cap — artefak pembulatan,
  // bukan SL yang lebih lebar. Sama persis dengan calculateOrderPlan.
  const slTolerance = Math.max(
    Number(input.tickSize ?? 0) / Math.max(1e-9, Number(input.entryPrice ?? 0)),
    SETUP_ENGINE.SWING_SL_CAP_TOLERANCE_PCT,
  );
  if (mode === "SWING" && (!Number.isFinite(input.structuralSlPct) || input.structuralSlPct! <= 0 || input.structuralSlPct! > swingSlBandMaxFor(input.strategyId) + slTolerance)) return denied("SWING_STRUCTURAL_SL_REQUIRED");
  const equity = Number(input.equityUsd);
  if (!Number.isFinite(equity) || equity <= 0) return { mode, slPct: 0, targetRiskUsd: 0, leverage: 1, notionalUsd: 0, marginUsd: 0, allowed: false, reason: "INSUFFICIENT_EQUITY", capped: false };
  const score = Math.max(0, Math.min(100, Number(input.score ?? 75)));
  const maxLev = Math.max(1, Math.min(MAX_LEVERAGE_SYSTEM, Number(input.maxLeverage ?? MAX_LEVERAGE_SYSTEM)));
  const lev = Math.max(1, Math.min(MAX_LEVERAGE_SYSTEM, maxLev));

  // ===== PERINTAH OPERATOR 25 Sep 2026 =====
  // Guard drawdown DIHAPUS TOTAL dari policy margin: equity turun (mis. $200 -> $184)
  // TIDAK BOLEH memblokir entry, karena slot posisi (maks 20) wajib selalu terisi.
  // Proteksi equity kini berbentuk PENURUNAN UKURAN RISIKO, bukan blokir entry:
  //   equity >= 75% modal -> risiko $1.00
  //   equity 50%-75%      -> risiko $0.75
  //   equity < 50%        -> risiko $0.50
  const equityRatio = equity / START_EQUITY_USD;
  let targetRisk = equityRatio >= 0.75 ? DEFAULT_RISK_USD : equityRatio >= 0.5 ? 0.75 : 0.5;
  let slPct: number;
  const seed = input.seed ?? `${mode}:${score}`;
  // Margin ACAK terkendali (risiko tetap $1): SL diundi per simbol dari rentang
  // per skor => margin tidak flat; plafon operator sekarang $4.80.
  // Skor tinggi => rentang rapat (margin cenderung besar); skor rendah => renggang.
  // Rentang dilebarkan (perintah operator 26 Sep 2026): 1.2%-2.2% anti-noise.
  const lo = score >= 85 ? 0.012 : score >= 75 ? 0.013 : 0.014;
  const hi = score >= 85 ? 0.016 : score >= 75 ? 0.02 : 0.022;
  slPct = Number((lo + hash01(seed, "sl") * (hi - lo)).toFixed(6));
  // Pagu margin $4.80: SL minimum dihitung dari budget risiko tetap.
  const scalpMinSl = targetRisk / (SCALP_MAX_MARGIN_USD * lev);
  slPct = mode === "SWING" ? input.structuralSlPct! : Math.max(slPct, Math.min(0.025, scalpMinSl));
  // Risiko dasar $1.00 (atau lebih kecil saat equity menipis) — variasi margin
  // murni dari SL% per simbol => tetap pecah alami.

  // Proteksi equity menipis SUDAH ditangani lewat targetRisk di atas (skala risiko),
  // sehingga TIDAK ADA blokir entry berbasis drawdown/equity (perintah operator:
  // slot wajib selalu bisa terisi).

  let notional = targetRisk / slPct;
  let margin = notional / lev;
  let capped = false;

  // Equity watch (<$18): pagu margin 25% equity, bukan 40%.
  const capPct = equity < EQUITY_HEALTHY_USD ? 0.25 : DEFAULT_MARGIN_CAP_PCT;
  const capUsd = equity * capPct;
  if (margin > capUsd) {
    const scale = capUsd / margin;
    notional = notional * scale;
    margin = capUsd;
    targetRisk = targetRisk * scale;
    capped = true;
  }

  // Pengaman tepi lev-rendah: bila margin SCALP masih > plafon,
  // pangkas notional (risiko turun proporsional, tak pernah naik).
  const modeMarginCap = maxMarginForMode(mode);
  if (margin > modeMarginCap && notional > 0) {
    if (mode === "SWING") return denied("RISK_FLOOR_MARGIN_CAP");
    const scale = modeMarginCap / margin;
    notional = notional * scale;
    margin = modeMarginCap;
    targetRisk = targetRisk * scale;
    capped = true;
  }

  // 30 Sep 2026 — refactor SCALP-only: cabang lantai alokasi mode lama dihapus.
  const finalLev = lev;

  if (!Number.isFinite(margin) || margin > capUsd + 1e-9) return { mode, slPct, targetRiskUsd: targetRisk, leverage: finalLev, notionalUsd: notional, marginUsd: margin, allowed: false, reason: "MARGIN_EXCEEDS_CAP", capped: true };

  return {
    mode,
    slPct: Number(slPct.toFixed(6)),
    targetRiskUsd: Number(targetRisk.toFixed(4)),
    leverage: finalLev,
    notionalUsd: Number(notional.toFixed(4)),
    marginUsd: Number(margin.toFixed(4)),
    allowed: true,
    reason: null,
    capped,
  };
}
