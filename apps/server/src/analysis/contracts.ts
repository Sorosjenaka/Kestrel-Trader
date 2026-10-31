// apps/server/src/analysis/contracts.ts - Kontrak data analisis ArtaTrade.
// 23 Okt 2026 (Tahap 3/4). Semua angka dihitung KODE; LLM hanya menginterpretasi.
//
// Prinsip keras:
//  - Field yang tidak ada TIDAK diisi 0. Tidak ada = undefined (hilang).
//  - Coverage hanya boleh 100% bila denominator diketahui.
//  - Setiap seri punya status sendiri (basi/terputus/termuat/panas/darurat).
//  - Skor 0-100 adalah INDEKS aturan, BUKAN probabilitas menang.
import { z } from "zod";

export const DATA_STATUS = [
  "LOADING",      // sedang memuat
  "WARMUP",       // histori belum cukup untuk hitungan
  "COMPLETE",     // lengkap & segar
  "PARTIAL",      // sebagian sumber ada
  "STALE",        // basi (melewati TTL)
  "DISCONNECTED", // terputus
  "UNSUPPORTED",  // tidak didukung feed ini
  "NO_DATA",      // sumber hidup, tapi memang tidak ada data (valid kosong)
] as const;
export type DataStatus = (typeof DATA_STATUS)[number];

/** Status data per feed — satu status per jenis data, TTL berbeda. */
export const dataStatusSchema = z.object({
  status: z.enum(DATA_STATUS),
  /** Umur data terakhir (ms). */
  ageMs: z.number().nullable(),
  /** Batas kesegaran (TTL) yang dipakai feed ini, ms. */
  ttlMs: z.number().int().positive(),
  /** Sumber yang gagal (bukan data kosong). */
  missing: z.array(z.string()).default([]),
  /** Sumber yang terpakai & sehat. */
  present: z.array(z.string()).default([]),
  /** Alasan singkat, bahasa Indonesia, tanpa jargon. */
  reason: z.string().nullable().default(null),
});
export type DataStatusInfo = z.infer<typeof dataStatusSchema>;

/** TTL per jenis data. Alasan ditulis di komentar — belum disetujui operator. */
export const DATA_TTL_MS = {
  /** Harga/trade: harus interfaz dengan tick pasar. 15 dtk = lebih cepat dari 1 tick 1m. */
  trades: 15_000,
  /** Book: bisa berubah tiap detik; 10 dtk masih "pasar hidup". */
  book: 10_000,
  /** Mark price: 5 dtk. */
  mark: 5_000,
  /** OI/funding: update per jam/8 jam. 10 menit masih segar. */
  oi: 600_000,
  /** Funding: 5 menit (perubahan kecil tapi decay cepat di display). */
  funding: 300_000,
  /** Event likuidasi: stream event; 60 dtk basi = tidak berguna. */
  liquidation: 60_000,
  /** Snapshot posisi/level: 30 dtk. */
  positionMap: 30_000,
  /** Kline 1h/4h: boleh lebih basi, 10 menit. */
  kline: 600_000,
} as const;
export type DataTtlKind = keyof typeof DATA_TTL_MS;

// ── Identitas pasar: simbol saja TIDAK cukup ──────────────────────────────
export const MARKET_TYPE = ["SPOT", "PERP"] as const;
export type MarketType = (typeof MARKET_TYPE)[number];

/**
 * Identitas penuh sebuah instrumen di sebuah venue.
 * field wajib: venue, marketType, instrumentId, base, quote, settlementAsset,
 * contractType (LINEAR | INVERSE | NONE), marginAsset.
 */
export const instrumentIdentitySchema = z.object({
  venue: z.string().min(1),
  marketType: z.enum(MARKET_TYPE),
  instrumentId: z.string().min(1),
  base: z.string().min(1),
  quote: z.string().min(1),
  settlementAsset: z.string().min(1),
  marginAsset: z.string().min(1),
  contractType: z.enum(["LINEAR", "INVERSE", "NONE"]),
});
export type InstrumentIdentity = z.infer<typeof instrumentIdentitySchema>;

// ── Metrik delta & CVD ───────────────────────────────────────────────────
/**
 * Delta notional: Σ(notional agresif beli) − Σ(notional agresif jual).
 * POSITIF = net buying agresif. BUKAN arus deposit/penarikan, BUKAN total
 * uang masuk/keluar, BUKAN "bandar buying".
 */
export const deltaWindowSchema = z.object({
  window: z.enum(["5m", "15m", "1h", "4h"]),
  buyNotional: z.number().nonnegative(),
  sellNotional: z.number().nonnegative(),
  buyRatio: z.number().min(0).max(1).nullable(),
  totalNotional: z.number().nonnegative(),
  tradeCount: z.number().int().nonnegative(),
  /** Delta = buy − sell (bukan net cash flow). */
  deltaNotional: z.number(),
  /** CVD sesi = akumulasi delta sejak awal sesi (07:00 WIB / 00:00 UTC). */
  cvdSession: z.number().nullable(),
  /** Diberi label berbeda dari cvdSession: direbase ke nol tiap ganti window. */
  rollingDelta: z.number(),
  /** Warm-up: histori BELUM cukup untuk menyebut ini "sesi lengkap". */
  warmup: z.boolean(),
  /** Berapa kali reconnect terjadi dalam window (kualitas data). */
  reconnectCount: z.number().int().nonnegative().default(0),
});
export type DeltaWindow = z.infer<typeof deltaWindowSchema>;

// ── Order book band ──────────────────────────────────────────────────────
export const bookBandSchema = z.object({
  /** Band tetap = persentase dari acuan, atau bergerak = mengikuti mark. */
  bandMode: z.enum(["FIXED_PCT", "FOLLOW_MARK"]),
  bandPct: z.number().positive(),
  /** Harga acuan yang dipakai (jelas menurut mode band). */
  referencePrice: z.number().positive(),
  bidNotional: z.number().nonnegative(),
  askNotional: z.number().nonnegative(),
  /** Imbalance (bid−ask)/(bid+ask) dalam −1..1. */
  imbalance: z.number().min(-1).max(1).nullable(),
  capturedAt: z.number().int().positive(),
});
export type BookBand = z.infer<typeof bookBandSchema>;

// ── Likuidasi: DUA jenis bukti yang tidak boleh dicampur ─────────────────
export const liquidationEventSchema = z.object({
  /** Event likuidasi yang SUDAH terjadi. */
  kind: z.literal("EVENT"),
  venue: z.string(),
  symbol: z.string(),
  /** Sisi yang dilikuidasi: LONGshort = long dilikuidasi. */
  liquidatedSide: z.enum(["LONG", "SHORT"]),
  price: z.number().positive(),
  qty: z.number().positive(),
  notionalUsd: z.number().positive(),
  eventTime: z.number().int().positive(),
});
export type LiquidationEvent = z.infer<typeof liquidationEventSchema>;

/**
 * Peta level posisi. TIDAK TERSEDIA di ArtaTrade saat ini (hanya own-account
 * Hyperliquid = estimasi model). Status wajib-jelas supaya UI tidak
 * menampilkan data sintetis seolah nyata.
 */
export const positionLevelMapSchema = z.object({
  kind: z.literal("POSITION_LEVEL_MAP"),
  venue: z.string(),
  symbol: z.string(),
  referencePrice: z.number().positive(),
  snapshotAt: z.number().int().positive(),
  /** Caoverage: berapa persen pasar yang benar-benar teramati. */
  coverage: z.number().min(0).max(1).nullable(),
  levels: z.array(z.object({
    price: z.number().positive(),
    longNotional: z.number().nonnegative(),
    shortNotional: z.number().nonnegative(),
    positionCount: z.number().int().nonnegative().nullable(),
  })),
  /** Keterangan cakupan: "semua akun", "own-account", "indeks subset". */
  coverageNote: z.string(),
});
export type PositionLevelMap = z.infer<typeof positionLevelMapSchema>;

// ── OI & funding ─────────────────────────────────────────────────────────
export const oiFundingSchema = z.object({
  venue: z.string(),
  symbol: z.string(),
  openInterest: z.number().nonnegative(),
  /** Perubahan JUMLAH kontrak. */
  openInterestContracts: z.number().nullable(),
  /** Perubahan NILAI USD (dipengaruhi harga bergerak) — jangan disamakan. */
  openInterestUsdChange: z.number().nullable(),
  fundingRate: z.number().nullable(),
  /** Periode funding (menit) — antar-venue tidak boleh dibandingkan tanpa ini. */
  fundingIntervalMinutes: z.number().int().positive().nullable(),
  fundingNextAt: z.number().int().nullable(),
  capturedAt: z.number().int().positive(),
});
export type OiFunding = z.infer<typeof oiFundingSchema>;

// ── Feature snapshot bersama (satu fetch untuk semua agen) ───────────────
export const featureSnapshotSchema = z.object({
  snapshotId: z.string().min(1),
  featureVersion: z.string().min(1),
  builtAt: z.number().int().positive(),
  /** Event time paling tua yang tercakup (untuk honesti coverage). */
  eventTimeMax: z.number().int().positive(),
  instrument: instrumentIdentitySchema,
  /** Status per jenis data. */
  dataStatus: z.record(z.string(), dataStatusSchema),
  /** Cakupan per sumber: {sumber: {ada, total}}. */
  coverage: z.record(z.string(), z.object({ present: z.number().int().nonnegative(), total: z.number().int().nonnegative() })),
  features: z.object({
    deltaByWindow: z.record(z.string(), deltaWindowSchema),
    /**
     * Delta per venue (key = "VENUE:MARKET:SYMBOL").
     * TIDAK boleh dijumlahkan mentah-mentah antar venue: definisi taker side
     * berbeda (Binance/Hyperliquid = taker eksplisit, Coinbase = maker yang
     * dibalik) dan cakupan likuiditas berbeda.
     */
    deltaByVenue: z.record(z.string(), z.record(z.string(), deltaWindowSchema)).default({}),
    bookBand: bookBandSchema.nullable(),
    liquidationEvent: liquidationEventSchema.nullable(),
    positionLevelMap: positionLevelMapSchema.nullable(),
    oiFunding: oiFundingSchema.nullable(),
  }),
  /** Referensi bukti (id log/DB) supaya UI bisa ditelusuri. */
  evidenceRefs: z.array(z.string()).default([]),
  /** Sumber yang berubah status sejak snapshot sebelumnya. */
  sourceSwitches: z.array(z.string()).default([]),
  /** Catatan keterbatasan yang WAJIB tampil di UI. */
  limitations: z.array(z.string()).default([]),
});
export type FeatureSnapshot = z.infer<typeof featureSnapshotSchema>;

// ── Output analis per strategi (bukan satu verdict global) ──────────────
export const analysisStance = ["SUPPORTED", "CONTRADICTED", "NEUTRAL", "INSUFFICIENT_DATA"] as const;
export type AnalysisStance = (typeof analysisStance)[number];

export const analysisRole = ["CONTEXT", "FILTER", "RANK"] as const;
export type AnalysisRole = (typeof analysisRole)[number];

/** Ringkasan UI: STATUS/ALASAN/PEMICU/BATAL, bahasa Indonesia. */
export const uiSummarySchema = z.object({
  status: z.enum(["TUNGGU", "BIAS NAIK", "BIAS TURUN", "TERBLOKIR", "BATAL", "DATA KURANG", "SIAP PAPER"]),
  alasan: z.string().min(1).max(400),
  pemicu: z.string().max(300),
  batal: z.string().max(300),
});
export type UiSummary = z.infer<typeof uiSummarySchema>;

export const strategyAnalysisSchema = z.object({
  analysisId: z.string().min(1),
  strategyId: z.string().min(1),
  agentId: z.string().min(1),
  snapshotId: z.string().min(1),
  candidateId: z.string().nullable().default(null),
  evaluatedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  marketHypothesis: z.string().min(1).max(600),
  horizon: z.string().min(1).max(120),
  /** Bukti yang mendukung. */
  supports: z.array(z.string()).max(12).default([]),
  /** Bukti yang bertentangan. */
  contradicts: z.array(z.string()).max(12).default([]),
  stance: z.enum(analysisStance),
  stanceReason: z.string().min(1).max(400),
  /** Harus merujuk aturan strategi yang BENAR-BENAR ada. */
  confirmConditions: z.array(z.string()).max(10).default([]),
  invalidateConditions: z.array(z.string()).max(10).default([]),
  waitingReason: z.string().max(300).nullable().default(null),
  role: z.enum(analysisRole),
  uiSummary: uiSummarySchema,
  evidenceRefs: z.array(z.string()).default([]),
});
export type StrategyAnalysis = z.infer<typeof strategyAnalysisSchema>;

/** Hasil satu batch analisis (3 strategi terpisah). */
export const analysisBatchSchema = z.object({
  batchId: z.string().min(1),
  snapshotId: z.string().min(1),
  createdAt: z.number().int().positive(),
  analyses: z.array(strategyAnalysisSchema),
  /** alasan batch tidak lengkap (LLM gagal/timeout) -> UI tampil "tidak tersedia". */
  degraded: z.string().nullable().default(null),
});
export type AnalysisBatch = z.infer<typeof analysisBatchSchema>;

// ── Telemetry agen (event nyata, bukan timer) ────────────────────────────
export const AGENT_TASK_STATE = [
  "IDLE", "SCANNING", "WAITING_DATA", "COMPUTING", "TRADING", "BLOCKED", "ERROR",
] as const;
export type AgentTaskState = (typeof AGENT_TASK_STATE)[number];

export const agentTaskSchema = z.object({
  taskId: z.string().min(1),
  agentId: z.string().min(1),
  kind: z.string().min(1),
  symbol: z.string().nullable().default(null),
  state: z.enum(AGENT_TASK_STATE),
  /** Progress TERUKUR — null kalau sistem tidak punya denominator. */
  progress: z.object({ current: z.number().int().nonnegative(), total: z.number().int().positive() }).nullable().default(null),
  startedAt: z.number().int().positive(),
  heartbeatAt: z.number().int().positive(),
  lastResultAt: z.number().int().nullable().default(null),
  /** Alasan menunggu/gagal — wajib ada kalau state BLOCKED/WAITING_DATA/ERROR. */
  blockedReason: z.string().nullable().default(null),
  sourceFeed: z.string().nullable().default(null),
  evidenceRefs: z.array(z.string()).default([]),
});
export type AgentTask = z.infer<typeof agentTaskSchema>;
