// apps/server/src/marketdata/microstructureTypes.ts
// Kontrak bersama 5 modul mikrostruktur & order flow (24 Okt 2026).
//
// Prinsip data (WAJIB — tidak boleh dilanggar):
//  - Semua angka berasal dari stream WS / REST exchange yang HIDUP atau API
//    Vike. Tidak ada data mock/random/placeholder di modul ini.
//  - Taker side dinormalisasi: +usd = taker BUY, -usd = taker SELL.
//    Coinbase hanya memberi MAKER side, jadi delta-nya proksi taker —
//    label venuemekasan: `takerSide: "MAKER_PROXY"` (lihat COINBASE_VENUE).
//  - When "since start" (retensi 7 hari) umur data ditampilkan jujur.

export type MarketKind = "spot" | "perp";

/** Venue = (exchange, market). Semua stream dinormalisasi ke daftar ini. */
export type VenueId =
  | "BINANCE_PERP"
  | "BINANCE_SPOT"
  | "HYPERLIQUID"
  | "COINBASE"
  | "BYBIT_PERP"
  | "BYBIT_SPOT"
  | "OKX"
  | "GATE"
  | "BITGET"
  | "KUCOIN";

export interface VenueMeta {
  id: VenueId;
  /** Label panjang untuk tabel/badge. */
  label: string;
  /** Label pendek untuk chart (sumbu harga). */
  short: string;
  /** Nama "exchange" untuk agregasi lintas market (BINANCE_SPOT+PERP -> BINANCE). */
  exchange: string;
  market: MarketKind;
  /** Warna badge sesuai spesifikasi operator. */
  color: string;
  /**
   * true = sisi yang dilaporkan bursa adalah MAKER, sehingga delta hanya
   * proksi arah taker. Wajib dibaca satu layer di atas.
   */
  takerSideIsMaker: boolean;
}

export const VENUES: readonly VenueMeta[] = [
  { id: "BINANCE_PERP", label: "Binance Futures", short: "BN-P", exchange: "BINANCE", market: "perp", color: "#f0b90b", takerSideIsMaker: false },
  { id: "BINANCE_SPOT", label: "Binance Spot", short: "BN-S", exchange: "BINANCE", market: "spot", color: "#22d3ee", takerSideIsMaker: false },
  { id: "HYPERLIQUID", label: "Hyperliquid Perp", short: "HL", exchange: "HYPERLIQUID", market: "perp", color: "#2dd4bf", takerSideIsMaker: false },
  { id: "COINBASE", label: "Coinbase Spot", short: "CB", exchange: "COINBASE", market: "spot", color: "#1652f0", takerSideIsMaker: true },
  { id: "BYBIT_PERP", label: "Bybit Linear", short: "BYBIT-P", exchange: "BYBIT", market: "perp", color: "#f7931a", takerSideIsMaker: false },
  { id: "BYBIT_SPOT", label: "Bybit Spot", short: "BYBIT-S", exchange: "BYBIT", market: "spot", color: "#fb923c", takerSideIsMaker: false },
  { id: "OKX", label: "OKX Spot", short: "OKX", exchange: "OKX", market: "spot", color: "#e5e7eb", takerSideIsMaker: false },
  { id: "GATE", label: "Gate.io Spot", short: "GATE", exchange: "GATE", market: "spot", color: "#007aff", takerSideIsMaker: false },
  { id: "BITGET", label: "Bitget Spot", short: "BITGET", exchange: "BITGET", market: "spot", color: "#00c278", takerSideIsMaker: false },
  { id: "KUCOIN", label: "KuCoin Spot", short: "KUCOIN", exchange: "KUCOIN", market: "spot", color: "#23b272", takerSideIsMaker: false },
] as const;

export const VENUE_BY_ID: Record<VenueId, VenueMeta> = Object.fromEntries(
  VENUES.map((v) => [v.id, v]),
) as Record<VenueId, VenueMeta>;

/** Urutan venue untuk chart per-exchange (sesuai urutan pill di Panel 5). */
export const EXCHANGE_ORDER: readonly string[] = [
  "BINANCE", "BYBIT", "OKX", "GATE", "KUCOIN", "COINBASE", "BITGET", "HYPERLIQUID",
] as const;

export const EXCHANGE_COLOR: Record<string, string> = {
  BINANCE: "#f0b90b",
  BYBIT: "#f7931a",
  OKX: "#ffffff",
  GATE: "#007aff",
  KUCOIN: "#23b272",
  COINBASE: "#1652f0",
  BITGET: "#00c278",
  HYPERLIQUID: "#2dd4bf",
};

// ── Simbol ────────────────────────────────────────────────────────────────────

/** Simbol kanonik tanpa suffix (BTC, ETH, SOL, ...). */
export type CanonicalSymbol = string;

/**
 * Simbol yang dilacak penuh (riwayat per-detik per venue). Sisanya tetap
 * dilacak untuk tape & volume profile, tapi hanya agregat menit.
 */
export const TRACKED_SYMBOLS: readonly string[] = [
  "BTC", "ETH", "SOL", "HYPE", "DOGE", "ZEC", "ZRO", "ENA",
  "ADA", "XRP", "LINK", "BNB", "NEAR", "WLD", "PUMP", "XMR",
] as const;

/** Simbol dengan riwayat CVD detail (per-detik, 1 jam). */
export const HISTORY_SYMBOLS: readonly string[] = [
  "BTC", "ETH", "SOL", "XRP", "DOGE", "WLD", "HYPE", "BNB",
] as const;

const HISTORY_SET = new Set(HISTORY_SYMBOLS);

/** true = simbol punya buffer CVD per-detik (Panel 1 & 5). */
export function isHistorySymbol(sym: string): boolean {
  return HISTORY_SET.has(sym.toUpperCase());
}

/** Peta simbol canonical -> format tiap venue. */
const SYMBOL_FORMATS: Record<VenueId, (base: string) => string> = {
  BINANCE_PERP: (b) => `${b}USDT`,
  BINANCE_SPOT: (b) => `${b}USDT`,
  HYPERLIQUID: (b) => b,
  COINBASE: (b) => `${b}-USD`,
  BYBIT_PERP: (b) => `${b}USDT`,
  BYBIT_SPOT: (b) => `${b}USDT`,
  OKX: (b) => `${b}-USDT`,
  GATE: (b) => `${b}_USDT`,
  BITGET: (b) => `${b}USDT`,
  KUCOIN: (b) => `${b}-USDT`,
};

/** Konversi simbol canonical -> format venue (mis. BTC -> BTC-USD). */
export function venueSymbol(venue: VenueId, base: string): string {
  return SYMBOL_FORMATS[venue](base.toUpperCase());
}

/**
 * Sufiks eksplisit per venue (dipisah dari format generator supaya parsing
 * inbound tidak pernah salah: "XUSDT" berakhiran "X" adalah jebakan).
 */
const VENUE_SUFFIX: Record<VenueId, string> = {
  BINANCE_PERP: "USDT",
  BINANCE_SPOT: "USDT",
  HYPERLIQUID: "",
  COINBASE: "-USD",
  BYBIT_PERP: "USDT",
  BYBIT_SPOT: "USDT",
  OKX: "-USDT",
  GATE: "_USDT",
  BITGET: "USDT",
  KUCOIN: "-USDT",
};

/** Ambil base dari simbol venue (BTC-USD -> BTC). */
export function baseFromVenueSymbol(venue: VenueId, raw: string): string {
  const s = raw.toUpperCase();
  const suffix = VENUE_SUFFIX[venue];
  if (!suffix) return s;
  if (s.endsWith(suffix) && s.length > suffix.length) return s.slice(0, -suffix.length);
  // Fallback: potong pada separator bila format tak terduga.
  const sep = s.search(/[-_]/);
  return sep > 0 ? s.slice(0, sep) : s;
}

// ── Size tier ────────────────────────────────────────────────────────────────

/**
 * Tier untuk FEED LARGE TRADES (Panel 4). Batas bawah $10K karena feed
 * hanya menampilkan transaksi >= $10K.
 */
export type LargeTradeTier = "MEGA" | "WHALE" | "LARGE" | "MEDIUM" | "SMALL";

export const LARGE_TRADE_TIER_FLOOR_USD = 10_000;

/** Tier untuk ANALISIS FLOW (Panel 5) — semua transaksi, termasuk ritel. */
export type FlowTier = "MEGA" | "WHALE" | "LARGE" | "MEDIUM" | "SMALL";

export const FLOW_TIERS: readonly FlowTier[] = ["MEGA", "WHALE", "LARGE", "MEDIUM", "SMALL"] as const;

/** Ambang tier flow (USD). SMALL = < $25K (ritel ikut dihitung). */
export const FLOW_TIER_BOUNDS = {
  MEGA: 1_000_000,
  WHALE: 500_000,
  LARGE: 100_000,
  MEDIUM: 25_000,
} as const;

/** Klasifikasi tier feed large-trades. Return null bila < $10K. */
export function largeTradeTier(usd: number): LargeTradeTier | null {
  if (!(usd >= LARGE_TRADE_TIER_FLOOR_USD)) return null;
  if (usd >= 1_000_000) return "MEGA";
  if (usd >= 500_000) return "WHALE";
  if (usd >= 100_000) return "LARGE";
  if (usd >= 50_000) return "MEDIUM";
  return "SMALL";
}

/** Klasifikasi tier flow — semua transaksi termasuk yang < $25K. */
export function flowTier(usd: number): FlowTier {
  if (usd >= FLOW_TIER_BOUNDS.MEGA) return "MEGA";
  if (usd >= FLOW_TIER_BOUNDS.WHALE) return "WHALE";
  if (usd >= FLOW_TIER_BOUNDS.LARGE) return "LARGE";
  if (usd >= FLOW_TIER_BOUNDS.MEDIUM) return "MEDIUM";
  return "SMALL";
}

/** Label tier untuk UI (Panel 5). */
export const FLOW_TIER_LABEL: Record<FlowTier, string> = {
  MEGA: "MEGA",
  WHALE: "WHALE",
  LARGE: "LARGE",
  MEDIUM: "MEDIUM",
  SMALL: "SMALL",
};

// ── Trade tape ───────────────────────────────────────────────────────────────

export interface TapeTrade {
  /** monoton naik, id unik dalam proses. */
  id: number;
  /** epoch ms. */
  t: number;
  venue: VenueId;
  /** simbol kanonik (BTC). */
  symbol: string;
  market: MarketKind;
  /** Sisi TAKER (sudah dibalik untuk venue yang hanya memberi maker side). */
  takerSide: "BUY" | "SELL";
  price: number;
  qty: number;
  usd: number;
  tier: FlowTier;
  /** Tier feed Panel 4 (null bila < $10K). */
  largeTier: LargeTradeTier | null;
}

// ── Book & wall ──────────────────────────────────────────────────────────────

export interface BookLevel {
  price: number;
  qty: number;
  notionalUsd: number;
}

export interface BookSnapshot {
  venue: VenueId;
  symbol: string;
  t: number;
  bids: BookLevel[];
  asks: BookLevel[];
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
}

export type WallEventKind = "appeared" | "moved" | "pulled" | "eaten";

export interface WallEvent {
  id: number;
  t: number;
  kind: WallEventKind;
  side: "BID" | "ASK";
  price: number;
  notionalUsd: number;
  /** jarak % dari mid saat event terjadi. */
  distPct: number;
  /** umur dinding dalam detik saat event terjadi (untuk pulled/eaten). */
  lifeSec: number;
  venue: VenueId;
  symbol: string;
}

export interface WallRecord {
  id: number;
  venue: VenueId;
  symbol: string;
  side: "BID" | "ASK";
  price: number;
  notionalUsd: number;
  appearedAt: number;
  lastSeenAt: number;
  state: "ACTIVE" | "PULLED" | "EATEN" | "MOVED";
  movedTo?: number;
}

// ── Likuidasi ────────────────────────────────────────────────────────────────

export interface LiquidationBin {
  price: number;
  /** Notional long yang liquidated bila harga jatuh ke level ini. */
  longUsd: number;
  /** Notional short yang liquidated bila harga naik ke level ini. */
  shortUsd: number;
  distPct: number;
}

export interface LiquidationMapSnapshot {
  symbol: string;
  /** sumber data aktif: vike | hyperliquid_onchain */
  source: "vike" | "hyperliquid_onchain";
  markPrice: number | null;
  updatedAt: number;
  /**
   * TAHAP 6B: epoch ms saat data UNDERLYING diambil dari sumber. Untuk Vike ini
   * = waktu fetch (cache TTL 60 dtk), untuk sampling on-chain = waktu polling
   * akun terakhir. `updatedAt` = waktu snapshot dirakit (= now) dan TIDAK
   * boleh dipakai sebagai penanda freshness.
   */
  sourceTsMs: number;
  /**
   * TAHAP 6B: epoch ms saat data DITERIMA proses (untuk Vike = waktu fetch
   * HTTP; untuk sampling = waktu polling selesai). Terpisah dari sourceTsMs
   * supaya delay sumber terlihat. Null = UNKNOWN.
   */
  sourceReceivedAtMs: number | null;
  stale: boolean;
  bins: LiquidationBin[];
  openPositions: number | null;
  openValueUsd: number | null;
  cum: {
    pct: number;
    longsUsd: number;
    shortsUsd: number;
    skewPct: number;
  }[];
  topLongClustersBelow: { price: number; distPct: number; liqUsd: number; positions: number }[];
  topShortClustersAbove: { price: number; distPct: number; liqUsd: number; positions: number }[];
  magnetDirection: "UP" | "DOWN" | "NONE";
  note: string;
}

// ── Volume profile ───────────────────────────────────────────────────────────

export interface VolumeProfileBin {
  price: number;
  buyUsd: number;
  sellUsd: number;
  totalUsd: number;
}

export interface VolumeProfileSnapshot {
  symbol: string;
  range: "1h" | "1d" | "7d";
  bins: VolumeProfileBin[];
  pocPrice: number | null;
  pocVolumeUsd: number;
  pocBuySharePct: number | null;
  vahPrice: number | null;
  valPrice: number | null;
  priceVsValueArea: "ABOVE_VAH" | "INSIDE_VA" | "BELOW_VAL" | "UNKNOWN";
  price: number | null;
  totalUsd: number;
  updatedAt: number;
  /** true = data sejak proses start (retensi 7 hari belum penuh). */
  partialWindow: boolean;
}

// ── Tier & flow ──────────────────────────────────────────────────────────────

export interface TierImbalanceRow {
  tier: FlowTier;
  buyUsd: number;
  sellUsd: number;
  netDeltaUsd: number;
  buySharePct: number;
  trades: number;
}

export interface PerExchangeDeltaPoint {
  t: number;
  delta: number;
}

export interface PerExchangeDeltaSeries {
  exchange: string;
  color: string;
  total: number;
  points: PerExchangeDeltaPoint[];
}

export interface DivergenceAlert {
  t: number;
  buyerExchange: string;
  buyerDelta: number;
  sellerExchange: string;
  sellerDelta: number;
  spreadUsd: number;
}

export type WhaleRetailBias =
  | "WHALE_ACCUMULATING"
  | "WHALE_DISTRIBUTING"
  | "ALIGNED_BULLISH"
  | "ALIGNED_BEARISH"
  | "NEUTRAL"
  | "UNKNOWN";

// ── Util angka ───────────────────────────────────────────────────────────────

export function fmtUsdCompact(n: number): string {
  const a = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(1)}K`;
  return `${sign}$${a.toFixed(0)}`;
}
