// apps/server/src/agents/marketIntel.ts
// MARKET INTELLIGENCE ENGINE (14 Okt 2026, master task Fase 3):
// fitur DETERMINISTIK + timestamped dari data pasar tervalidasi — BUKAN
// interpretasi LLM. Output = MarketContextSnapshot schema
// "artatrade-market-intelligence-v1" yang dikonsumsi LLM Market Analyst yang
// SUDAH ADA (marketAnalyst.ts) dan disajikan ke UI + lapisan keputusan.
//
// Kebijakan data (documented):
//  - Universe: simbol eligible dari DB (Symbol.eligible), dibatasi top N
//    (MARKET_INTEL_UNIVERSE, default 25) berdasarkan volume24hUsd.
//  - Return 1h: klines 1h (limit 2) per simbol — 25 panggilan/siklus dengan
//    cache kline 60 dtk, beban rate-limit rendah.
//  - Return 24h: cache ticker 24h binanceFuturesClient (tanpa panggilan baru).
//  - Regime BTC: dari 24 bar 1h — konsistensi arah bar + slope regresi linear
//    + volatilitas (ATR% proxy high-low). Ambang eksplisit di bawah.
//  - Likuiditas: depth (fapi/v1/depth) untuk MAX 3 simbol likuiditas per
//    siklus (BTC/ETH/SOL) — notional dekat-mid ±0.25%, imbalance bid/ask.
//  - Likuidasi: agregat LiquidationHub (event OBSERVED, bukan estimasi).
//  - Kualitas data: setiap angka berasal dengan timestamp; coverage < minimum
//    → fitur "missing", BUKAN nol palsu.
import { db } from "../core/db.js";
import { binanceFuturesClient } from "../markets/binanceFuturesClient.js";
import { liquidationHub } from "../marketdata/liquidationHub.js";
import { multiVenueOrderFlowHub } from "../marketdata/multiVenueOrderFlowHub.js";
import { wallLifelines } from "../marketdata/wallLifelines.js";
import { liquidationMapHub } from "../marketdata/liquidationMapHub.js";
import { volumeProfileHub } from "../marketdata/volumeProfileHub.js";
import { tierFlowHub } from "../marketdata/tierFlowHub.js";
import { logger } from "../core/logger.js";

export const INTEL_SCHEMA_VERSION = "artatrade-market-intelligence-v1";

export type Regime = "TREND_UP" | "TREND_DOWN" | "RANGE" | "MIXED" | "EXTREME" | "UNKNOWN";
export type Bias = "BULLISH" | "BEARISH" | "NEUTRAL" | "MIXED" | "UNKNOWN";

export interface IntelSymbolRow {
  symbol: string; price: number; chg1hPct: number | null; chg24hPct: number | null;
  quoteVolumeUsd: number | null; freshnessMs: number | null;
}
export interface LiquidityFeature {
  symbol: string; bidNotionalNear: number; askNotionalNear: number;
  imbalance: number | null; // (bid-ask)/(bid+ask), -1..1; null bila depth kosong
  walls: { side: "bid" | "ask"; price: number; notionalUsd: number; distPct: number }[];
  fetchedAt: number; stale: boolean;
}
/**
 * Blok mikrostruktur & order flow (BAGIAN 3, 24 Okt 2026).
 * Semua field fail-open: null = modul belum siap / data tidak tersedia.
 * Sumber: 5 hub live di marketdata/ — BUKAN estimasi atau mock.
 */
export interface MicrostructureFlowBlock {
  /** CVD agregat dari 10 venue (multiVenueOrderFlowHub). */
  orderFlowCvd: {
    allVenues: number | null;
    perpSum: number | null;
    spotSum: number | null;
    venuesTrading: number;
    venuesExpected: number;
    /** Delta CVD 15m terakhir (null bila belum ada data). */
    delta15m: number | null;
  } | null;
  /** Siklus hidup wall (wallLifelines). */
  wallLifelines: {
    active: number;
    pulled: number;
    eaten: number;
    moved: number;
    appeared: number;
    largestActiveUsd: number;
    largestActiveSide: "BID" | "ASK" | null;
    largestActivePrice: number | null;
    /** Rasio pulled vs eaten — tinggi = banyak spoofing. */
    pullEatRatio: number | null;
  } | null;
  /** Peta likuidasi ±15% (liquidationMapHub). */
  liquidationMap: {
    source: "vike" | "hyperliquid_onchain" | null;
    magnetDirection: "UP" | "DOWN" | "NONE" | null;
    /** Kumulatif likuidasi dalam ±2% dari mark. */
    nearLongUsd: number | null;
    nearShortUsd: number | null;
    nearSkewPct: number | null;
    /** Cluster terbesar di bawah mark (long liq). */
    topClusterBelow: { price: number; liqUsd: number; distPct: number } | null;
    /** Cluster terbesar di atas mark (short liq). */
    topClusterAbove: { price: number; liqUsd: number; distPct: number } | null;
    stale: boolean;
    note: string | null;
  } | null;
  /** Volume profile + large trades (volumeProfileHub). */
  volumeProfile: {
    pocPrice: number | null;
    vahPrice: number | null;
    valPrice: number | null;
    priceVsValueArea: string | null;
    totalUsd: number | null;
    pocBuySharePct: number | null;
    partialWindow: boolean;
  } | null;
  /** Tier imbalance + divergensi exchange (tierFlowHub). */
  tierAndExchangeFlow: {
    whaleBias: string | null;
    megaDeltaUsd: number | null;
    whaleDeltaUsd: number | null;
    retailDeltaUsd: number | null;
    /** Divergensi antar-exchange (terbesar). */
    topDivergence: { buyerExchange: string; sellerExchange: string; spreadUsd: number } | null;
  } | null;
  /** Status keseluruhan blok. */
  status: "AVAILABLE" | "PARTIAL" | "UNAVAILABLE";
}

export interface MarketContextSnapshot {
  schema_version: string;
  analysis_id: string;
  generated_at: string;   // ISO
  computed_at_ms: number;
  universe: { target: number; valid: number; coverage_ratio: number; source: "db.eligible+binance" };
  breadth: { positive: number; negative: number; valid: number; coverage_ratio: number; interval: "24h" };
  breadth_1h: { positive: number; negative: number; valid: number; coverage_ratio: number };
  btc_relative_strength: { value_1h: number | null; classification: "STRONG" | "WEAK" | "NEUTRAL" | "UNKNOWN"; benchmark: string[] };
  regime: { label: Regime; btc_chg_24h: number | null; consistency: number | null; atr_pct_1h: number | null; thresholds: string };
  liquidity: { status: "AVAILABLE" | "PARTIAL" | "UNAVAILABLE"; symbols: LiquidityFeature[] };
  liquidations: { status: "OBSERVED_ACTIVITY" | "NO_RECENT_EVENTS" | "UNAVAILABLE"; windowMin: number; longLiqUsd: number; shortLiqUsd: number; totalUsd: number; count: number; top: { symbol: string; notionalUsd: number; count: number }[]; stream: string };
  /** Blok mikrostruktur & order flow (BAGIAN 3, 24 Okt 2026). */
  microstructure_and_flow: MicrostructureFlowBlock;
  data_quality: {
    status: "FRESH" | "PARTIAL" | "STALE" | "INVALID";
    coverage_ratio: number; missing_features: string[]; source_timestamps: Record<string, number>;
  };
}

const uid = () => `mi_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

/** Breadth dari daftar return (null = data tidak valid, dikecualikan). */
export function computeBreadth(returns: (number | null)[]): { positive: number; negative: number; valid: number; coverage_ratio: number } {
  let pos = 0, neg = 0, valid = 0;
  for (const r of returns) {
    if (r == null || !Number.isFinite(r)) continue;
    valid++;
    if (r > 0) pos++; else if (r < 0) neg++;
  }
  return { positive: pos, negative: neg, valid, coverage_ratio: returns.length ? valid / returns.length : 0 };
}

/** Klasifikasi kekuatan relatif BTC (ambang ±0.25% terhadap benchmark 1h). */
export function classifyRelativeStrength(btc1h: number | null, bench1h: number | null): { value_1h: number | null; classification: "STRONG" | "WEAK" | "NEUTRAL" | "UNKNOWN" } {
  if (btc1h == null || bench1h == null || !Number.isFinite(btc1h) || !Number.isFinite(bench1h)) {
    return { value_1h: null, classification: "UNKNOWN" };
  }
  const value = btc1h - bench1h;
  return { value_1h: Number(value.toFixed(3)), classification: value > 0.25 ? "STRONG" : value < -0.25 ? "WEAK" : "NEUTRAL" };
}

/** Regime BTC deterministik dari 24 bar 1h (ambang eksplisit, belum dikalibrasi). */
export function classifyRegime(closes: number[], chg24h: number | null): { label: Regime; consistency: number; atrPct: number } {
  if (closes.length < 10) return { label: "UNKNOWN", consistency: 0, atrPct: 0 };
  const signs = closes.slice(1).map((c, i) => Math.sign(c - closes[i]!));
  const up = signs.filter((s) => s > 0).length;
  const down = signs.filter((s) => s < 0).length;
  const consistency = Math.max(up, down) / signs.length; // 0..1
  // ATR% proxy: rata-rata (high-low)/close — caller memberi closes saja, jadi
  // gunakan volatilitas bar-to-bar sebagai proxy yang jujur.
  const rets = closes.slice(1).map((c, i) => Math.abs((c - closes[i]!) / closes[i]!));
  const atrPct = (rets.reduce((a, b) => a + b, 0) / rets.length) * 100;
  let label: Regime;
  if (atrPct > 3) label = "EXTREME"; // volatilitas di luar rentang operasi normal
  else if (consistency >= 0.65 && up > down) label = "TREND_UP";
  else if (consistency >= 0.65 && down > up) label = "TREND_DOWN";
  else if (consistency <= 0.55) label = "RANGE"; // termasuk bolak-balik sempurna (0.545)
  else label = "MIXED";
  return { label, consistency: Number(consistency.toFixed(2)), atrPct: Number(atrPct.toFixed(2)) };
}

/** Imbalance likuiditas dekat-mid dari depth (bukan prediksi arah). */
export function computeLiquidityFeature(symbol: string, depth: { bids: [string, string][]; asks: [string, string][] }, now = Date.now()): LiquidityFeature {
  const bestBid = Number(depth.bids[0]?.[0] ?? 0);
  const bestAsk = Number(depth.asks[0]?.[0] ?? 0);
  const mid = (bestBid + bestAsk) / 2;
  let bidN = 0, askN = 0;
  const walls: LiquidityFeature["walls"] = [];
  if (mid > 0) {
    for (const [p, q] of depth.bids) {
      const price = Number(p), qty = Number(q);
      if (!(price > 0) || !(qty > 0)) continue;
      const notional = price * qty;
      const distPct = ((price - mid) / mid) * 100;
      if (Math.abs(distPct) <= 0.25) bidN += notional;
      walls.push({ side: "bid", price, notionalUsd: notional, distPct });
    }
    for (const [p, q] of depth.asks) {
      const price = Number(p), qty = Number(q);
      if (!(price > 0) || !(qty > 0)) continue;
      const notional = price * qty;
      const distPct = ((price - mid) / mid) * 100;
      if (Math.abs(distPct) <= 0.25) askN += notional;
      walls.push({ side: "ask", price, notionalUsd: notional, distPct });
    }
  }
  walls.sort((a, b) => b.notionalUsd - a.notionalUsd);
  return {
    symbol,
    bidNotionalNear: Math.round(bidN),
    askNotionalNear: Math.round(askN),
    imbalance: bidN + askN > 0 ? Number(((bidN - askN) / (bidN + askN)).toFixed(3)) : null,
    walls: walls.slice(0, 4),
    fetchedAt: now,
    stale: !(mid > 0),
  };
}

/** Status kualitas data gabungan (validasi snapshot — jangan bohongi konsumen). */
export function computeDataQuality(input: {
  coverage: number; universeTarget: number; depthOk: number; depthTried: number;
  liqState: string; generatedAtMs: number; lastTickerAgeMs: number | null; extraMissing?: string[];
}): MarketContextSnapshot["data_quality"] {
  const missing: string[] = [...(input.extraMissing ?? [])];
  if (input.coverage < 0.5) missing.push("universe_coverage<50%");
  if (input.depthTried === 0 || input.depthOk === 0) missing.push("orderbook_depth");
  else if (input.depthOk < input.depthTried) missing.push("orderbook_partial");
  if (input.liqState !== "CONNECTED") missing.push("liquidation_stream");
  const coverage = input.universeTarget > 0 ? input.coverage : 0;
  const status: MarketContextSnapshot["data_quality"]["status"] =
    missing.length === 0 && coverage >= 0.9 && (input.lastTickerAgeMs ?? Infinity) < 60_000 ? "FRESH"
    : coverage >= 0.5 ? "PARTIAL"
    : (input.lastTickerAgeMs ?? Infinity) < 120_000 ? "PARTIAL"
    : "STALE";
  return {
    status,
    coverage_ratio: Number(coverage.toFixed(3)),
    missing_features: missing,
    source_timestamps: { computed_at: input.generatedAtMs },
  };
}

/**
 * Rakit blok mikrostruktur & order flow dari 5 hub live (BAGIAN 3).
 * Fail-open per-modul: bila satu hub error, field-nya null — tidak
 * menggagalkan seluruh snapshot. Data 100% dari stream nyata.
 */
/** Ekspor untuk Drex SWING v2 shadow & panel AI (TAHAP 4/5): bukti mikrostruktur
 *  per simbol kandidat, dibangun dari hub live yang sama dengan API panel. */
export async function buildMicrostructureBlock(symbol: string): Promise<MicrostructureFlowBlock> {
  let orderFlowCvd: MicrostructureFlowBlock["orderFlowCvd"] = null;
  let wallLifelinesData: MicrostructureFlowBlock["wallLifelines"] = null;
  let liquidationMap: MicrostructureFlowBlock["liquidationMap"] = null;
  let volumeProfile: MicrostructureFlowBlock["volumeProfile"] = null;
  let tierAndExchangeFlow: MicrostructureFlowBlock["tierAndExchangeFlow"] = null;
  let availableCount = 0;

  // 1) Order flow CVD dari multiVenueOrderFlowHub.
  try {
    const snap = multiVenueOrderFlowHub.buildSnapshot(symbol, "15m");
    orderFlowCvd = {
      allVenues: snap.cvd.allVenues,
      perpSum: snap.cvd.perpSum,
      spotSum: snap.cvd.spotSum,
      venuesTrading: snap.venuesTrading,
      venuesExpected: snap.venuesExpected,
      delta15m: snap.cvd.allVenues, // buildSnapshot window=15m -> delta sudah 15m
    };
    availableCount++;
  } catch { /* fail-open */ }

  // 2) Wall lifelines dari wallLifelines tracker.
  try {
    const ws = wallLifelines.snapshot(symbol);
    const totalEaten = ws.summary.eaten || 1;
    wallLifelinesData = {
      active: ws.summary.active,
      pulled: ws.summary.pulled,
      eaten: ws.summary.eaten,
      moved: ws.summary.moved,
      appeared: ws.summary.appeared,
      largestActiveUsd: ws.summary.largestActiveUsd,
      largestActiveSide: ws.summary.largestActiveSide,
      largestActivePrice: ws.summary.largestActivePrice,
      pullEatRatio: ws.summary.pulled / totalEaten,
    };
    availableCount++;
  } catch { /* fail-open */ }

  // 3) Liquidation map dari liquidationMapHub.
  try {
    const lm = await liquidationMapHub.snapshot(symbol);
    const near2 = lm.cum.find((c) => c.pct === 2);
    liquidationMap = {
      source: lm.source,
      magnetDirection: lm.magnetDirection,
      nearLongUsd: near2?.longsUsd ?? null,
      nearShortUsd: near2?.shortsUsd ?? null,
      nearSkewPct: near2?.skewPct ?? null,
      topClusterBelow: lm.topLongClustersBelow[0]
        ? { price: lm.topLongClustersBelow[0].price, liqUsd: lm.topLongClustersBelow[0].liqUsd, distPct: lm.topLongClustersBelow[0].distPct }
        : null,
      topClusterAbove: lm.topShortClustersAbove[0]
        ? { price: lm.topShortClustersAbove[0].price, liqUsd: lm.topShortClustersAbove[0].liqUsd, distPct: lm.topShortClustersAbove[0].distPct }
        : null,
      stale: lm.stale,
      note: lm.note,
    };
    availableCount++;
  } catch { /* fail-open */ }

  // 4) Volume profile dari volumeProfileHub.
  try {
    const vp = volumeProfileHub.build(symbol, "1h");
    volumeProfile = {
      pocPrice: vp.pocPrice,
      vahPrice: vp.vahPrice,
      valPrice: vp.valPrice,
      priceVsValueArea: vp.priceVsValueArea,
      totalUsd: vp.totalUsd,
      pocBuySharePct: vp.pocBuySharePct,
      partialWindow: vp.partialWindow,
    };
    availableCount++;
  } catch { /* fail-open */ }

  // 5) Tier & exchange flow dari tierFlowHub.
  try {
    const rangeSec = 900; // 15 menit
    const tiers = tierFlowHub.tiers(symbol, rangeSec);
    const bias = tierFlowHub.whaleRetailBias(symbol, rangeSec);
    const divergences = tierFlowHub.scanDivergences(symbol);
    const mega = tiers.find((t) => t.tier === "MEGA");
    const whale = tiers.find((t) => t.tier === "WHALE");
    const retail = tiers.filter((t) => t.tier === "MEDIUM" || t.tier === "SMALL");
    const retailDelta = retail.reduce((s, r) => s + r.netDeltaUsd, 0);
    tierAndExchangeFlow = {
      whaleBias: bias.bias,
      megaDeltaUsd: mega?.netDeltaUsd ?? null,
      whaleDeltaUsd: (mega?.netDeltaUsd ?? 0) + (whale?.netDeltaUsd ?? 0),
      retailDeltaUsd: retailDelta,
      topDivergence: divergences[0]
        ? { buyerExchange: divergences[0].buyerExchange, sellerExchange: divergences[0].sellerExchange, spreadUsd: divergences[0].spreadUsd }
        : null,
    };
    availableCount++;
  } catch { /* fail-open */ }

  const status: MicrostructureFlowBlock["status"] =
    availableCount >= 4 ? "AVAILABLE" : availableCount >= 2 ? "PARTIAL" : "UNAVAILABLE";

  return {
    orderFlowCvd,
    wallLifelines: wallLifelinesData,
    liquidationMap,
    volumeProfile,
    tierAndExchangeFlow,
    status,
  };
}

/** Ringkasan teks mikrostruktur untuk prompt LLM (Council / agen lain). */
export function buildMicrostructureSummary(m: MicrostructureFlowBlock | null): string {
  if (!m || m.status === "UNAVAILABLE") return "Data mikrostruktur & order flow tidak tersedia.";
  const lines: string[] = [`[Mikrostruktur & Order Flow] status=${m.status}`];
  if (m.orderFlowCvd) lines.push(`  CVD: $${((m.orderFlowCvd.allVenues ?? 0) / 1e6).toFixed(2)}M, ${m.orderFlowCvd.venuesTrading}/${m.orderFlowCvd.venuesExpected} venue`);
  if (m.wallLifelines) lines.push(`  Wall: aktif=${m.wallLifelines.active}, pulled=${m.wallLifelines.pulled}, eaten=${m.wallLifelines.eaten}, rasio p/e=${m.wallLifelines.pullEatRatio != null ? m.wallLifelines.pullEatRatio.toFixed(2) : "n/a"}`);
  if (m.volumeProfile) lines.push(`  VolProfile: POC=$${m.volumeProfile.pocPrice?.toFixed(2) ?? "n/a"}, harga ${m.volumeProfile.priceVsValueArea ?? "?"} VA, total=$${((m.volumeProfile.totalUsd ?? 0) / 1e6).toFixed(1)}M`);
  if (m.liquidationMap) lines.push(`  LiqMap: magnet=${m.liquidationMap.magnetDirection ?? "NONE"}, near long=$${((m.liquidationMap.nearLongUsd ?? 0) / 1e6).toFixed(2)}M, near short=$${((m.liquidationMap.nearShortUsd ?? 0) / 1e6).toFixed(2)}M`);
  if (m.tierAndExchangeFlow) lines.push(`  TierFlow: bias=${m.tierAndExchangeFlow.whaleBias ?? "UNKNOWN"}, whale=$${((m.tierAndExchangeFlow.whaleDeltaUsd ?? 0) / 1e6).toFixed(2)}M, retail=$${((m.tierAndExchangeFlow.retailDeltaUsd ?? 0) / 1e6).toFixed(2)}M`);
  return lines.join("\n");
}

/**
 * Blok mikrostruktur siap-prompt untuk agen yang butuh ringkasan 5 modul
 * tetapi tidak punya MarketContextSnapshot sendiri (Vega, Sena, Rhea, Bima,
 * Nadira, Raksa, Sesha, Laras, Varuna, Kirana, /api/agents/ask).
 *
 * RINGAN: hanya membaca hub in-memory — tidak query DB, tidak fetch REST
 * baru. Peta likuidasi sendiri ter-cache 60 detik di dalam hub.
 *
 * Fail-open: kalau tidak ada data yang bisa dipakai, kembalikan string
 * KOSONG (bukan kalimat "data tidak tersedia" yang menyesatkan model).
 */
const MICRO_PROMPT_TTL_MS = 5_000;
const microPromptCache = new Map<string, { at: number; text: string }>();

/** "SOLUSDT" -> "SOL". Hub mikrostruktur melacak simbol dasar (BTC, ETH, SOL). */
function normalizeMicroSymbol(raw: string): string {
  const s = String(raw ?? "").trim().toUpperCase();
  for (const quote of ["USDT", "USDC", "USD", "PERP"]) {
    if (s.length > quote.length + 1 && s.endsWith(quote)) return s.slice(0, -quote.length);
  }
  return s;
}

export async function buildMicrostructurePromptBlock(symbol = "BTC"): Promise<string> {
  const sym = normalizeMicroSymbol(symbol);
  if (!sym) return "";
  const hit = microPromptCache.get(sym);
  if (hit && Date.now() - hit.at < MICRO_PROMPT_TTL_MS) return hit.text;
  let text = "";
  try {
    const m = await buildMicrostructureBlock(sym);
    if (m && m.status !== "UNAVAILABLE") {
      text = `=== MIKROSTRUKTUR & ORDER FLOW (5 modul) ===\n${buildMicrostructureSummary(m)}\n`;
    }
  } catch {
    text = "";
  }
  microPromptCache.set(sym, { at: Date.now(), text });
  return text;
}

/** Rangkai snapshot penuh. Semua IO fail-open; snapshot INVALID tetap terstruktur. */
export async function gatherMarketContextSnapshot(opts?: { depthSymbols?: string[] }): Promise<MarketContextSnapshot> {
  const universeTarget = Math.max(5, Number(process.env.MARKET_INTEL_UNIVERSE ?? 25));
  const missing: string[] = [];
  // 1) Universe eligible terurut volume.
  const symbols = await db.symbol.findMany({
    where: { eligible: true },
    orderBy: { volume24hUsd: "desc" },
    take: universeTarget,
    select: { symbol: true, volume24hUsd: true },
  }).catch(() => [] as { symbol: string; volume24hUsd: number | null }[]);
  const names = symbols.map((s) => s.symbol);
  const coverage = universeTarget > 0 ? names.length / universeTarget : 0;
  if (names.length === 0) missing.push("universe_empty");

  // 2) Ticker 24h dari cache hub (tanpa panggilan REST baru).
  const { map: hub, ageMs: hubAge } = binanceFuturesClient.getHubPrices(names);
  const chg24Map = binanceFuturesClient.getHubChg24(names);
  const rows: IntelSymbolRow[] = names.map((s) => {
    const h = hub[s];
    return {
      symbol: s,
      price: h ? Number(h.p) : NaN,
      chg1hPct: null,
      chg24hPct: chg24Map[s] ?? null,
      quoteVolumeUsd: symbols.find((x) => x.symbol === s)?.volume24hUsd ?? null,
      freshnessMs: h ? Date.now() - h.t : null,
    };
  });
  if (hubAge > 30_000) missing.push("ticker_cache_stale");

  // 3) Return 1h via klines (top N, cache 60 dtk membuatnya murah setelah siklus pertama).
  const chg1h = new Map<string, number | null>();
  await Promise.all(names.slice(0, universeTarget).map(async (s) => {
    const kl = await binanceFuturesClient.fetchKlines(s, "1h", 2).catch(() => [] as any[]);
    if (Array.isArray(kl) && kl.length >= 2) {
      const prev = Number(kl[0][4]), last = Number(kl[1][4]);
      if (prev > 0 && Number.isFinite(last)) chg1h.set(s, Number((((last - prev) / prev) * 100).toFixed(3)));
    }
  }));
  for (const r of rows) r.chg1hPct = chg1h.get(r.symbol) ?? null;
  const breadth1h = computeBreadth(rows.map((r) => r.chg1hPct));

  // 4) Regime BTC dari 24 bar 1h.
  const btcKl = await binanceFuturesClient.fetchKlines("BTCUSDT", "1h", 25).catch(() => [] as any[]);
  const closes = Array.isArray(btcKl) ? btcKl.map((k: any[]) => Number(k[4])).filter(Number.isFinite) : [];
  const btcRow = rows.find((r) => r.symbol === "BTCUSDT");
  const regime = classifyRegime(closes, btcRow?.chg1hPct ?? null);

  // 5) Relative strength BTC vs benchmark mayor (rata-rata sama-rata, documented).
  const BENCH = ["ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"];
  const benchVals = BENCH.map((s) => chg1h.get(s)).filter((v): v is number => v != null);
  const benchAvg = benchVals.length >= 2 ? benchVals.reduce((a, b) => a + b, 0) / benchVals.length : null;
  const btc1h = chg1h.get("BTCUSDT") ?? null;
  const rs = classifyRelativeStrength(btc1h, benchAvg);

  // 6) Likuiditas: depth max 3 simbol (fail-open).
  const depthSyms = (opts?.depthSymbols ?? ["BTCUSDT", "ETHUSDT", "SOLUSDT"]).slice(0, 3)
    .filter((s) => names.includes(s) || s === "BTCUSDT");
  const liqFeatures: LiquidityFeature[] = [];
  await Promise.all(depthSyms.map(async (s) => {
    try {
      const d = await binanceFuturesClient.fetchDepth(s, 500);
      liqFeatures.push(computeLiquidityFeature(s, d));
    } catch { /* depth gagal → fitur missing, bukan nol palsu */ }
  }));
  const depthOk = liqFeatures.filter((f) => !f.stale).length;

  // 7) Likuidasi OBSERVED dari hub.
  liquidationHub.start();
  const liqSum = liquidationHub.summary(120);
  const liqStatus: MarketContextSnapshot["liquidations"]["status"] =
    liqSum.count > 0 ? "OBSERVED_ACTIVITY" : "NO_RECENT_EVENTS";
  const liqStreamState = liquidationHub.dataState();

  const dq = computeDataQuality({
    coverage,
    universeTarget,
    depthOk,
    depthTried: depthSyms.length,
    liqState: liqStreamState,
    generatedAtMs: Date.now(),
    lastTickerAgeMs: hubAge,
    extraMissing: missing,
  });

  // 8) Blok mikrostruktur & order flow (BAGIAN 3, 24 Okt 2026).
  //    Semua hub fail-open: try/catch per-modul, null = tidak tersedia.
  //    Simbol utama = BTC (likuiditas terdalam di semua venue).
  const microSymbol = "BTC";
  const micro = await buildMicrostructureBlock(microSymbol);

  const breadth24 = computeBreadth(rows.map((r) => r.chg24hPct));
  const snap: MarketContextSnapshot = {
    schema_version: INTEL_SCHEMA_VERSION,
    analysis_id: uid(),
    generated_at: new Date().toISOString(),
    computed_at_ms: Date.now(),
    universe: { target: universeTarget, valid: names.length, coverage_ratio: Number(coverage.toFixed(3)), source: "db.eligible+binance" },
    breadth: { ...breadth24, interval: "24h" },
    breadth_1h: breadth1h,
    btc_relative_strength: { ...rs, benchmark: BENCH },
    regime: {
      label: regime.label,
      btc_chg_24h: btcRow?.chg24hPct ?? null,
      consistency: regime.consistency,
      atr_pct_1h: regime.atrPct,
      thresholds: "EXTREME: barATR%>3; TREND: konsistensi arah>=0.65; RANGE: <=0.55; di antaranya MIXED (belum terkalibrasi)",
    },
    liquidity: { status: depthOk === 0 ? "UNAVAILABLE" : depthOk < depthSyms.length ? "PARTIAL" : "AVAILABLE", symbols: liqFeatures },
    liquidations: {
      status: liqStatus, windowMin: liqSum.windowMin,
      longLiqUsd: liqSum.longLiqUsd, shortLiqUsd: liqSum.shortLiqUsd,
      totalUsd: liqSum.totalNotionalUsd, count: liqSum.count, top: liqSum.topSymbols,
      stream: `${liqStreamState}/${liquidationHub.eventState()}`,
    },
    microstructure_and_flow: micro,
    data_quality: dq,
  };
  logger.info({ analysis_id: snap.analysis_id, universe: names.length, regime: snap.regime.label, dq: dq.status }, "MARKET_INTEL_SNAPSHOT");
  return snap;
}
