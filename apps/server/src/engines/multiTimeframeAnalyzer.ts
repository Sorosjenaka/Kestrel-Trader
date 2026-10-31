// apps/server/src/engines/multiTimeframeAnalyzer.ts
// ANALISIS MULTI-TIMEFRAME untuk pair yang ditradingkan (saklar utama mesin setup).
// Menyatukan: regime + ZLEMA (bias), zona SnD/OB/FVG + skor 5 faktor (struktur),
// squeeze BB-dalam-KC (trigger) — semua deterministik, tanpa LLM.
import { Bar, calculateAdx, calculateChoppiness } from "../universe/eligibility.js";
import {
  calculateAtr,
  calculateZeroLagTrend,
  classifyRegimeSmoothed,
  evaluateVolatilityShield,
  type MarketRegime,
  type TrendDirection,
} from "./regimeTrendEngine.js";
import { analyzePairZonesAndTrigger, type DetectedZone, type PairZonesAndTriggerResult } from "./zoneTriggerEngine.js";
import { getTimeframePlan, SWING_TIMEFRAMES, type TfInterval, type TfRole, type TradingModeName } from "../config/timeframes.js";
// 13 Okt 2026 — lane SWING: mesin sinyal S-05 dievaluasi di bar 1h tertutup.
// 20 Okt 2026 (perintah operator: "untuk yang fibo tolong hapus itu") — S-03
// Fibonacci DIHAPUS. Gate "usable" lane SWING tidak lagi bergantung pada
// fibArmed (itulah yang membuat analisis usable saat setup fib armed).
// 20 Okt 2026 (AU1-01) — koreksi: usable = DATA-SUFFICIENCY ("snapshot
// timeframe tersedia + harga > 0"), BUKAN "ada sinyal S-05". Sinyal breakout
// S-05 tetap DIHITUNG di bar tertutup terakhir, tapi hanya untuk skor
// (triggerScore/compositeScore) dan arah — bukan sebagai gerbang `usable`.
// Strategi RSW-01/02/03 punya trigger sendiri (H4/H1) dan tidak bergantung
// pada analysis.usable.
// 21 Okt 2026 (Phase 5): S-05 Polaris dipindahkan ke arsip riset. Mesin sinyal
// tetap hidup untuk historical replay + worker forward paper Polaris; entry
// S-05 baru tidak ada lagi.
import { latestSwingBreakoutSignal, SWING_WARMUP } from "../strategies/swingBreakoutEngine.js";

/** Fetcher klines yang bisa di-inject (test offline memakai stub). */
export type KlineFetcher = (symbol: string, interval: string, limit: number) => Promise<unknown[]>;

/** Konversi lilin Binance mentah (array) menjadi Bar terketik. */
export function klinesToBars(raw: unknown): Bar[] {
  return (Array.isArray(raw) ? raw : [])
    .map((b: any) => ({
      openTime: Number(b?.[0]),
      open: Number(b?.[1]),
      high: Number(b?.[2]),
      low: Number(b?.[3]),
      close: Number(b?.[4]),
      volume: Number(b?.[5]),
    }))
    .filter((b) => Number.isFinite(b.openTime) && Number.isFinite(b.close) && b.close > 0);
}

export interface TfSnapshot {
  interval: TfInterval;
  role: TfRole;
  available: boolean;
  bars: number;
  atr: number | null;
  atrPct: number | null;
  regime: MarketRegime;
  trend: TrendDirection;
  trendScore: number;
  zlema: number | null;
  adx: number | null;
  chop: number | null;
  shieldActive: boolean;
  zoneScore: number;
  bestZone: DetectedZone | null;
  usableZones: DetectedZone[];
  squeezeOn: boolean;
  squeezeRelease: boolean;
  squeezeDirection: "LONG" | "SHORT" | "NEUTRAL";
  squeezeTarget: number | null;
  triggerScore: number;
  barsData: Bar[];
}

export interface MtfAnalysis {
  symbol: string;
  mode: TradingModeName;
  timeframes: TfSnapshot[];
  trigger: TfSnapshot;
  structure: TfSnapshot;
  bias: TfSnapshot;
  /** TF konfirmasi momentum (SCALP 3m sejak 28 Sep 2026; null bila mode tanpa CONFIRM). */
  confirm: TfSnapshot | null;
  confirmAligned: boolean;
  zoneScore: number;
  triggerScore: number;
  trendScore: number;
  compositeScore: number;
  biasAligned: boolean;
  side: "LONG" | "SHORT";
  bestZone: DetectedZone | null;
  zoneAnalysis: PairZonesAndTriggerResult | null;
  atrTrigger: number | null;
  atrStructure: number | null;
  price: number;
  usable: boolean;
  reason: string | null;
  tfSummary: string;
  analyzedAt: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function emptySnapshot(interval: TfInterval, role: TfRole): TfSnapshot {
  return {
    interval,
    role,
    available: false,
    bars: 0,
    atr: null,
    atrPct: null,
    regime: "UNCERTAIN",
    trend: "NEUTRAL",
    trendScore: 50,
    zlema: null,
    adx: null,
    chop: null,
    shieldActive: false,
    zoneScore: 0,
    bestZone: null,
    usableZones: [],
    squeezeOn: false,
    squeezeRelease: false,
    squeezeDirection: "NEUTRAL",
    squeezeTarget: null,
    triggerScore: 40,
    barsData: [],
  };
}

/** Analisis satu timeframe (regime + trend + zona + squeeze). */
export function analyzeTimeframe(
  symbol: string,
  interval: TfInterval,
  role: TfRole,
  bars: Bar[],
  atrPeriod = 14
): TfSnapshot {
  const snap = emptySnapshot(interval, role);
  snap.barsData = bars;
  snap.bars = bars.length;
  if (bars.length < 30) return snap;

  snap.available = true;
  const last = bars[bars.length - 1]!;
  snap.atr = calculateAtr(bars, atrPeriod);
  snap.atrPct = snap.atr && last.close > 0 ? Number(((snap.atr / last.close) * 100).toFixed(4)) : null;

  const regime = classifyRegimeSmoothed(bars, 0, 5);
  snap.regime = regime.regime;
  const trend = calculateZeroLagTrend(bars, { period: 21 });
  snap.trend = trend.direction;
  snap.zlema = Number(trend.zlema.toFixed(8));
  snap.trendScore = clamp(Math.round(trend.trendScore), 5, 98);
  const adx = calculateAdx(bars, 14);
  snap.adx = adx ? Number(adx.adx.toFixed(2)) : null;
  snap.chop = calculateChoppiness(bars, 14);
  const shield = evaluateVolatilityShield(bars, 0);
  snap.shieldActive = shield.active;

  // Zona SMC/SnD + skor 5 faktor (FR-09) + squeeze trigger (FR-10)
  const zoneResult = analyzePairZonesAndTrigger(symbol, bars, { trendDirection: trend.direction });
  snap.zoneScore = zoneResult.zoneScore;
  snap.bestZone = zoneResult.bestZone;
  snap.usableZones = zoneResult.usableZones;
  snap.squeezeOn = zoneResult.trigger.squeezeOn;
  snap.squeezeRelease = zoneResult.trigger.squeezeRelease;
  snap.squeezeDirection = zoneResult.trigger.direction;
  snap.squeezeTarget = zoneResult.trigger.expectedTargetPrice || null;
  snap.triggerScore = clamp(Math.round(zoneResult.triggerScore), 20, 98);
  return snap;
}

// ───────────────────────── CACHE (hemat kuota REST) ─────────────────────────
const mtfCache = new Map<string, { at: number; value: MtfAnalysis }>();

export function clearMtfCache(): void {
  mtfCache.clear();
}

export function getCachedMtf(symbol: string, mode: string, ttlMs: number, now = Date.now()): MtfAnalysis | null {
  const hit = mtfCache.get(`${mode}:${symbol.toUpperCase()}`);
  if (!hit) return null;
  if (now - hit.at > ttlMs) return null;
  return hit.value;
}

function putCachedMtf(symbol: string, mode: string, value: MtfAnalysis, now = Date.now()): void {
  mtfCache.set(`${mode}:${symbol.toUpperCase()}`, { at: now, value });
  if (mtfCache.size > 400) {
    // buang entri tertua
    const oldest = [...mtfCache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100);
    for (const [k] of oldest) mtfCache.delete(k);
  }
}

/**
 * Analisis lane SWING (S-05 Swing Breakout, 13 Okt 2026): seluruh analisis
 * memakai bar 1h yang SUDAH TUTUP (anti-lookahead — bar berjalan dipotong),
 * dengan sinyal mesin S-05 dievaluasi di bar tertutup terakhir.
 *
 * Snapshots disusun manual (bukan analyzeTimeframe) supaya:
 *  - trigger/structure = SERI 1h TERTUTUP yang sama dengan input mesin S-05
 *    (ATR/pivot plan SWING_TIMEFRAMES memang dari 1h; tidak ada fetch ganda);
 *  - bias = snapshot 1h yang sama (netral-aman; gate arah tetap milik sinyal).
 *
 * 21 Okt 2026 (Phase 5): `usable` TIDAK mensyaratkan sinyal S-05 — semenjak
 * 20 Okt 2026 (AU1-01) `usable` = data-sufficiency (snapshot tersedia + harga
 * > 0), supaya paritas live <-> replay. Fail-closed tetap terjaga di level
 * STRATEGI: S-05 (arsip) butuh sinyal breakout-nya sendiri, dan RSW-01/02/03
 * butuh trigger H4/H1 masing-masing. Lihat catatan lengkap di dalam fungsi.
 */
export async function analyzeSwingTimeframe(
  symbol: string,
  fetchKlines: KlineFetcher,
  opts: { now?: number; cacheTtlMs?: number; skipCache?: boolean } = {}
): Promise<MtfAnalysis> {
  const modeName: TradingModeName = "SWING";
  const now = opts.now ?? Date.now();
  const ttl = opts.cacheTtlMs ?? 45_000;
  if (!opts.skipCache) {
    const cached = getCachedMtf(symbol, modeName, ttl, now);
    if (cached) return cached;
  }
  let raw = await fetchKlines(symbol, "1h", 300).catch(() => [] as unknown[]);
  // Anti-lookahead: buang bar berjalan (belum tutup). Bar 1h tutup tiap 60 menit.
  // Raw bisa array Binance [t,o,h,l,c,v] ATAU object {openTime} — baca keduanya
  // (bug ditangkap test swingLane: raw.openTime pada array = NaN -> tak pernah potong).
  const lastRaw = raw[raw.length - 1] as unknown;
  const lastOpenTime = Array.isArray(lastRaw)
    ? Number(lastRaw[0])
    : Number((lastRaw as { openTime?: unknown } | undefined)?.openTime);
  if (raw.length && Number.isFinite(lastOpenTime) && now - lastOpenTime < 3_600_000) {
    raw = raw.slice(0, -1);
  }
  const bars = klinesToBars(raw);
  if (bars.length < SWING_WARMUP) {
    const empty: TfSnapshot = {
      symbol, interval: "1h", role: "TRIGGER", available: false, atr: null, atrPct: null,
      trend: "NEUTRAL", trendScore: 0, regime: "DATA_UNAVAILABLE", squeezeRelease: false,
      squeezeDirection: "NEUTRAL", zoneScore: 0, barsData: [],
    } as unknown as TfSnapshot;
    return {
      symbol: symbol.toUpperCase(), mode: modeName, timeframes: [empty],
      trigger: empty, structure: empty, bias: empty, confirm: null, confirmAligned: true,
      zoneScore: 0, triggerScore: 0, trendScore: 0, compositeScore: 0,
      biasAligned: true, side: "LONG", bestZone: null, zoneAnalysis: null,
      atrTrigger: null, atrStructure: null, price: 0, usable: false,
      reason: "INSUFFICIENT_KLINES:1h", tfSummary: SWING_TIMEFRAMES.summary, analyzedAt: now,
    } as unknown as MtfAnalysis;
  }
  const closed = bars;
  const signal = latestSwingBreakoutSignal(closed);
  // 20 Okt 2026 (AU1-01, BLOCKER): `usable` = ANALISIS CUKUP untuk dievaluasi
  // (data-sufficiency), BUKAN "ada sinyal S-05".
  //
  // SEBELUMNYA usable = Boolean(sinyal S-05). Akibatnya gate di
  // autonomousTradingBot.fillSwingSlotsOnce (`if (!analysis?.usable) continue;`)
  // men-skip simbol SEBELUM selectBestPlan() -> buildRswPlans() dipanggil,
  // sehingga RSW-01/02/03 praktis tidak pernah fire (92,6% window hilang) --
  // persis kebalikan dari perintah operator ("RSW tetap aktif").
  //
  // SEKARANG usable mengikuti semantik yang sama dengan composeMtfAnalysis
  // (jalur replay/backtest): "snapshot timeframe tersedia + harga > 0".
  // Ini mengembalikan PARITAS live <-> replay: di replay RSW sudah bisa fire
  // karena gate-nya data-sufficiency.
  //
  // KEAMANAN (fail-closed) TIDAK berubah:
  //  - S-05 tetap butuh sinyal breakout-nya sendiri. evaluateSwingBreakout
  //    (setupStrategies.ts) sudah push "SWING_NO_SIGNAL_ON_LAST_CLOSED_H1"
  //    dan plan.matched=false bila latestSwingBreakoutSignal() null.
  //  - RSW-01/02/03 tetap butuh trigger H4/H1 masing-masing; buildRswPlans
  //    (rswPlans.ts) return [] bila h4Bars < 200 / h1Bars < 801.
  //  - Gate strategi lain (S-01/S-02) tidak berubah: mereka membaca
  //    ctx.analysis.usable di setupStrategies.ts dan tetap fail-closed.
  //  - Order hanya terjadi bila plan.matched === true (lihat funnel).
  // `signal` tetap dipakai untuk skor (triggerScore/compositeScore) & side.
  const atrPeriod = SWING_TIMEFRAMES.specs[0]?.atrPeriod ?? 20;
  const snapshot: TfSnapshot = analyzeTimeframe(symbol, "1h", "TRIGGER", closed as never, atrPeriod);
  if (!snapshot.available) {
    // Bar kurang dari 30 (analyzeTimeframe membutuhkan minimum) — fail-closed
    // dengan struktur MtfAnalysis utuh (bukan object setengah jadi).
    const priceEarly = closed[closed.length - 1]?.close ?? 0;
    return {
      symbol: symbol.toUpperCase(), mode: modeName, timeframes: [snapshot],
      trigger: snapshot, structure: snapshot, bias: snapshot, confirm: null,
      confirmAligned: true, zoneScore: 0, triggerScore: 0, trendScore: snapshot.trendScore,
      compositeScore: 0, biasAligned: true, side: "LONG", bestZone: null, zoneAnalysis: null,
      atrTrigger: null, atrStructure: null, price: priceEarly, usable: false,
      reason: "INSUFFICIENT_KLINES:1h", tfSummary: SWING_TIMEFRAMES.summary, analyzedAt: now,
    } as unknown as MtfAnalysis;
  }
  const snapStructure: TfSnapshot = { ...snapshot, role: "STRUCTURE" as const };
  const snapBias: TfSnapshot = { ...snapshot, role: "BIAS" as const };
  const price = closed[closed.length - 1]!.close;
  // 20 Okt 2026 (AU1-01): usable = data-sufficiency (lihat catatan di atas) —
  // PARITAS dengan composeMtfAnalysis di jalur replay/backtest.
  const usable = price > 0;
  // 20 Okt 2026 (BUG-5): Skor deterministik dari snapshot — paritas dengan
  // composeMtfAnalysis(). triggerScore langsung dari snapshot.triggerScore
  // (clamp 20-98 via analyzeTimeframe), compositeScore = weighted blend
  // trend/zone/trigger. Tidak lagi bergantung pada sinyal S-05 yang sudah retired.
  const side: "LONG" | "SHORT" = signal ? signal.side : (snapshot.trend === "BEARISH" ? "SHORT" : "LONG");
  const biasAligned = true; // arah datang dari sinyal mesin, bukan bias TF atas
  const swingTriggerScore = snapshot.triggerScore;
  const swingCompositeScore = Math.round(
    snapshot.trendScore * 0.35 + snapshot.zoneScore * 0.35 + swingTriggerScore * 0.30
  );
  const analysis: MtfAnalysis = {
    symbol: symbol.toUpperCase(),
    mode: modeName,
    timeframes: [snapshot],
    trigger: snapshot,
    structure: snapStructure,
    bias: snapBias,
    confirm: null,
    confirmAligned: true,
    zoneScore: snapshot.zoneScore,
    triggerScore: swingTriggerScore,
    trendScore: snapshot.trendScore,
    compositeScore: swingCompositeScore,
    biasAligned,
    side,
    bestZone: null,
    zoneAnalysis: null,
    atrTrigger: snapshot.atr,
    atrStructure: snapshot.atr,
    price,
    usable,
    reason: usable ? null : "NO_SWING_SETUP",
    tfSummary: SWING_TIMEFRAMES.summary,
    analyzedAt: now,
  };
  if (usable) putCachedMtf(symbol, modeName, analysis, now);
  return analysis;
}

/**
 * Analisis lengkap timeframe pair: SCALP 4 TF (trigger/konfirmasi/struktur/bias).
 * 30 Sep 2026 — refactor SCALP-only: peta 3-TF lama dihapus.
 * Mengembalikan skor zona/trigger/trend NYATA + zona terbaik sebagai POI entry.
 */
export async function analyzeMultiTimeframe(
  symbol: string,
  mode: string,
  fetchKlines: KlineFetcher,
  opts: { now?: number; cacheTtlMs?: number; skipCache?: boolean } = {}
): Promise<MtfAnalysis> {
  // 13 Okt 2026 — lane SWING kembali (S-05 Swing Breakout): trigger = bar 1h
  // yang SUDAH TUTUP; mesin sinyal S-05 dievaluasi di bar tertutup terakhir.
  // SCALP tetap memakai peta TF lama tanpa diubah satu bit.
  if (mode === "SWING") return analyzeSwingTimeframe(symbol, fetchKlines, opts);
  // 30 Sep 2026 — refactor SCALP-only: peta timeframe tunggal (SCALP).
  void mode;
  const modeName: TradingModeName = "SCALP";
  const plan = getTimeframePlan(modeName);
  const now = opts.now ?? Date.now();
  const ttl = opts.cacheTtlMs ?? 45_000;

  if (!opts.skipCache) {
    const cached = getCachedMtf(symbol, modeName, ttl, now);
    if (cached) return cached;
  }

  const specs = plan.specs;
  const rawList = await Promise.all(
    specs.map(async (spec) => {
      try {
        const raw = await fetchKlines(symbol, spec.interval, spec.limit);
        return klinesToBars(raw);
      } catch {
        return [] as Bar[];
      }
    })
  );

  const snapshots: TfSnapshot[] = specs.map((spec, i) =>
    analyzeTimeframe(symbol, spec.interval, spec.role, rawList[i] ?? [], spec.atrPeriod)
  );

  const analysis = composeMtfAnalysis(symbol, modeName, snapshots, now);
  if (analysis.usable) putCachedMtf(symbol, modeName, analysis, now);
  return analysis;
}

/** Pure composition shared by live analysis and historical closed-candle replay. */
export function composeMtfAnalysis(symbol: string, modeName: TradingModeName, snapshots: TfSnapshot[], now: number): MtfAnalysis {
  const plan = getTimeframePlan(modeName);
  const byRole = (role: TfRole): TfSnapshot => snapshots.find((s) => s.role === role) ?? snapshots[0]!;
  const trigger = byRole("TRIGGER");
  const structure = byRole("STRUCTURE");
  const bias = byRole("BIAS");
  const confirm = snapshots.find((s) => s.role === "CONFIRM") ?? null;

  const zoneResult = structure.available ? analyzePairZonesAndTrigger(symbol, structure.barsData, { trendDirection: bias.trend }) : null;

  // ── Skor gabungan (deterministik) ──
  const trendScore = clamp(Math.round(bias.trendScore * 0.7 + trigger.trendScore * 0.3), 5, 98);
  const zoneScore = clamp(Math.round(zoneResult?.zoneScore ?? structure.zoneScore), 0, 98);
  const momentum = trigger.barsData.length > 1
    ? Math.abs((trigger.barsData[trigger.barsData.length - 1]!.close - trigger.barsData[trigger.barsData.length - 5]?.close || 0) /
        trigger.barsData[trigger.barsData.length - 1]!.close) * 100
    : 0;
  const triggerScore = clamp(
    Math.round(
      trigger.squeezeRelease
        ? 70 + (trigger.squeezeDirection === bias.trend ? 15 : 0) + Math.min(10, momentum * 1.5)
        : 45 + Math.min(30, momentum * 5)
    ),
    20,
    98
  );
  // Bobot skor: SCALP menyertakan TF konfirmasi 3m (operator 28 Sep 2026).
  // Bobot 0.15 untuk konfirmasi diambil proporsional dari komponen lain agar
  // skor tetap 0-100. 30 Sep 2026 — refactor SCALP-only: cabang mode lain dihapus.
  const confirmScore = confirm ? clamp(Math.round(confirm.trendScore), 20, 98) : null;
  const compositeScore = confirmScore === null
    ? Math.round(trendScore * 0.35 + zoneScore * 0.35 + triggerScore * 0.30)
    : Math.round(trendScore * 0.30 + zoneScore * 0.30 + triggerScore * 0.25 + confirmScore * 0.15);

  const price = structure.barsData.length
    ? structure.barsData[structure.barsData.length - 1]!.close
    : trigger.barsData.length
    ? trigger.barsData[trigger.barsData.length - 1]!.close
    : 0;

  // Arah: ikut bias 15m/4h; kalau bias netral, ikut trigger; bila keduanya
  // netral, ikut konfirmasi 3m (SCALP) sebelum menyatakan NEUTRAL.
  const dirFromBias: "LONG" | "SHORT" | "NEUTRAL" =
    bias.trend === "BULLISH"
      ? "LONG"
      : bias.trend === "BEARISH"
      ? "SHORT"
      : trigger.trend === "BULLISH"
      ? "LONG"
      : trigger.trend === "BEARISH"
      ? "SHORT"
      : confirm?.trend === "BULLISH"
      ? "LONG"
      : confirm?.trend === "BEARISH"
      ? "SHORT"
      : "NEUTRAL";
  const side: "LONG" | "SHORT" = dirFromBias === "SHORT" ? "SHORT" : "LONG";
  const biasAligned = bias.trend === "NEUTRAL" || (side === "LONG" ? bias.trend === "BULLISH" : bias.trend === "BEARISH");
  // TF konfirmasi TIDAK memveto entry (gate tidak dilonggarkan/diketatkan);
  // nilainya dilaporkan di analisis agar bisa diuji-bandingkan di replay OOS.
  const confirmAligned = confirm === null || confirm.trend === "NEUTRAL"
    || (side === "LONG" ? confirm.trend === "BULLISH" : confirm.trend === "BEARISH");

  const missing = snapshots.filter((s) => !s.available).map((s) => s.interval);
  const usable = snapshots.every((s) => s.available) && price > 0;
  const reason = usable ? null : `INSUFFICIENT_KLINES:${missing.join("+")}`;

  const analysis: MtfAnalysis = {
    symbol: symbol.toUpperCase(),
    mode: modeName,
    timeframes: snapshots,
    trigger,
    structure,
    bias,
    confirm,
    confirmAligned,
    zoneScore,
    triggerScore,
    trendScore,
    compositeScore,
    biasAligned,
    side,
    bestZone: zoneResult?.bestZone ?? null,
    zoneAnalysis: zoneResult,
    atrTrigger: trigger.atr,
    atrStructure: structure.atr,
    price,
    usable,
    reason,
    tfSummary: plan.summary,
    analyzedAt: now,
  };

  return analysis;
}
