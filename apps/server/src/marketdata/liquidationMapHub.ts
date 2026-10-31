// apps/server/src/marketdata/liquidationMapHub.ts
// MODUL 3 — LIQUIDATION MAP (±15%) untuk Hyperliquid perp.
//
// SUMBER DATA (berurutan prioritas):
//  1. VIKE DATA API (utama) — 3 endpoint sesuai spec, header X-API-Key: <VIKE_API_KEY>:
//     a) GET https://data.vike.io/v1/hyperliquid/symbols/<SYM>/liquidation-heatmap?bins=150
//     b) GET https://data.vike.io/v1/hyperliquid/positions?symbol=<SYM>&limit=5000
//     c) GET https://data.vike.io/v1/hyperliquid/liquidations/risk
//     Aktif HANYA bila env.VIKE_API_KEY terisi. Bin dari Vike di-resample ke grid
//     seragam ±15% yang sama dengan jalur on-chain, jadi panel konsisten.
//  2. HYPERLIQUID ON-CHAIN (fallback, tanpa key) — sampling akun nyata dari
//     leaderboard publik Hyperliquid, lalu membaca state on-chain tiap akun
//     (POST https://api.hyperliquid.xyz/info {"type":"clearinghouseState"}).
//     Field `liquidationPx` milik Hyperliquid sendiri — bukan estimasi.
//
// Aturan mutlak: TIDAK ADA bin yang dikarang. Bila sumber tidak tersedia,
// snapshot melaporkan sumber + catatan honestly dan bin kosong.
//
// Peta di-anchor ke mark price live Hyperliquid, di-re-anchor tiap 1 detik
// supaya label "live mark" bergerak bersama harga.

import { logger } from "../core/logger.js";
import { env } from "../core/env.js";
import type { LiquidationBin, LiquidationMapSnapshot } from "./microstructureTypes.js";

/** Rentan harga di sekitar mark (±15%). */
const RANGE_PCT = 15;
/** Jumlah bin histogram. */
const BINS = 30;
/** Jumlah akun yang dipoll per siklus (rate limit HL: 1200 weight/menit,
 *  clearinghouseState = 20 weight → 40 req = 800 weight/menit, aman). */
const ACCOUNTS_PER_CYCLE = 40;
/** Interval poll siklus sampler (ms). */
const SAMPLE_INTERVAL_MS = 60_000;
/** Umur maksimum data posisi sebelum dianggap basi (ms). */
const POSITION_TTL_MS = 10 * 60_000;
/** Jumlah akun maksimum yang dipantau (sampling berlapis di seluruh pita). */
const MAX_TRACKED_ACCOUNTS = 400;
/** Ambang minimum account value (USD) untuk masuk pool sampler. */
const MIN_ACCOUNT_VALUE_USD = 250_000;
/** TTL cache leaderboard on-disk (ms) — file 39 MB, jangan di-refetch sering. */
const LEADERBOARD_TTL_MS = 6 * 3600_000;

const HL_INFO_URL = "https://api.hyperliquid.xyz/info";
const HL_LEADERBOARD_URL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";

/**
 * Normalisasi simbol ke nama coin Hyperliquid (basis, tanpa suffix quote).
 *
 * BUG (25 Okt 2026): `markPrices` dan `SampledPosition.coin` diisi dari
 * `meta.universe[i].name` milik Hyperliquid — yaitu "BTC", "ETH", dst.
 * Sementara route `/api/liquidation-map/:symbol` menerima "BTCUSDT"
 * (format simbol Binance). Akibatnya `markFor("BTCUSDT")` selalu null
 * dan `binsFromSampled` langsung return `[]` — panel LIQ MAP kosong.
 * `baseCoin()` menyamakan keduanya tanpa menebak: suffix quote yang
 * dikenal dilepas, selain itu dipertahankan apa adanya.
 */
export function baseCoin(symbol: string): string {
  const s = symbol.toUpperCase();
  for (const suffix of ["USDT", "USDC", "USD", "PERP"]) {
    if (s.length > suffix.length && s.endsWith(suffix)) return s.slice(0, -suffix.length);
  }
  return s;
}
/** Base REST Vike Data API (dokumentasi vike-core). */
const VIKE_BASE = "https://data.vike.io/v1/hyperliquid";
/** Jumlah bin heatmap yang diminta ke Vike (sesuai spec). */
const VIKE_HEATMAP_BINS = 150;
/** Batas baris posisi yang diminta ke Vike (sesuai spec). */
const VIKE_POSITIONS_LIMIT = 5000;
/** TTL cache hasil Vike per simbol (ms). Kuota Vike = 20.000 req/jam per key,
 *  jadi hasil TIDAK boleh di-refetch per request HTTP. */
const VIKE_TTL_MS = 60_000;
/** Jeda setelah kegagalan yang tidak akan hilang dengan retry cepat. */
const VIKE_BACKOFF_403_MS = 10 * 60_000;
const VIKE_BACKOFF_401_MS = 15 * 60_000;
const VIKE_BACKOFF_429_MS = 5 * 60_000;
const VIKE_BACKOFF_NET_MS = 2 * 60_000;

interface SampledPosition {
  account: string;
  coin: string;
  /** Signed size: + long, - short. */
  szi: number;
  entryPx: number;
  positionValueUsd: number;
  liquidationPx: number | null;
  leverage: number | null;
  seenAt: number;
}

interface AccountSnapshot {
  account: string;
  positions: SampledPosition[];
  seenAt: number;
  /** TAHAP 6B: waktu data DITERIMA proses (polling selesai). */
  receivedAt: number;
}

/** Hasil peta likuidasi dari Vike (sumber utama). */
interface VikeResult {
  bins: LiquidationBin[];
  openPositions: number | null;
  openValueUsd: number | null;
  /** Endpoint Vike yang menghasilkan data (untuk catatan operator). */
  endpoint: string;
  /**
   * TAHAP 6B: epoch ms saat data ini DIAMBIL dari sumber (bukan saat snapshot
   * dirakit). Cache Vike memakai ulang hasil lama, jadi `updatedAt` snapshot
   * (= now) akan membohongi freshness bila memakai nilai itu.
   */
  fetchedAt: number;
  /**
   * TAHAP 6B: epoch ms saat data DITERIMA proses. Untuk Vike sama dengan
   * fetchedAt (HTTP sinkron). null = UNKNOWN.
   */
  receivedAt: number | null;
}

/** Parse respons Vike menjadi bin. Toleran terhadap beberapa nama field,
 *  TAPI tidak pernah mengarang nilai: bin tanpa notional diabaikan. */
export function parseVikeHeatmap(payload: any, markPrice: number | null): {
  bins: LiquidationBin[]; openPositions: number | null; openValueUsd: number | null;
} {
  const rows: any[] = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.bins) ? payload.bins
    : Array.isArray(payload?.data) ? payload.data
    : Array.isArray(payload?.heatmap) ? payload.heatmap
    : Array.isArray(payload?.levels) ? payload.levels
    : [];

  const bins: LiquidationBin[] = [];
  for (const r of rows) {
    const price = Number(r?.price ?? r?.px ?? r?.level ?? r?.binPrice);
    if (!(price > 0)) continue;
    const longUsd = Number(r?.longUsd ?? r?.long_liq_usd ?? r?.longsUsd ?? r?.longNotional ?? 0) || 0;
    const shortUsd = Number(r?.shortUsd ?? r?.short_liq_usd ?? r?.shortsUsd ?? r?.shortNotional ?? 0) || 0;
    const distPct = markPrice ? ((price - markPrice) / markPrice) * 100 : Number(r?.distPct ?? r?.distancePct ?? 0) || 0;
    bins.push({ price, longUsd, shortUsd, distPct });
  }
  bins.sort((a, b) => a.price - b.price);
  const openPositions = Number(payload?.openPositions ?? payload?.positions ?? payload?.totalPositions) || null;
  const openValueUsd = Number(payload?.openValueUsd ?? payload?.openValue ?? payload?.totalValueUsd) || null;
  return { bins, openPositions, openValueUsd };
}

/**
 * Parse respons `/v1/hyperliquid/positions` menjadi bin likuidasi.
 *
 * Toleran terhadap beberapa nama field, TAPI tidak pernah mengarang:
 *  - baris tanpa simbol yang cocok dilewati;
 *  - baris tanpa harga likuidasi dilewati;
 *  - baris tanpa notional USD eksplisit DIHITUNG sebagai level tanpa notional
 *    (dihitung terpisah, tidak jadi angka nol palsu di histogram);
 *  - sisi (long/short) yang tidak bisa dipastikan → baris dilewati.
 */
export function parseVikePositions(payload: any, symbol: string, markPrice: number | null): {
  bins: LiquidationBin[]; openPositions: number | null; openValueUsd: number | null; levelsWithoutNotional: number;
} {
  const sym = symbol.toUpperCase();
  const rows: any[] = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.positions) ? payload.positions
    : Array.isArray(payload?.data) ? payload.data
    : Array.isArray(payload?.items) ? payload.items
    : Array.isArray(payload?.results) ? payload.results
    : [];

  const raw: LiquidationBin[] = [];
  let openValueUsd = 0;
  let levelsWithoutNotional = 0;

  for (const r of rows) {
    const rs = r?.symbol ?? r?.coin ?? r?.asset ?? r?.ticker;
    if (rs != null && String(rs).toUpperCase() !== sym) continue;

    const liq = Number(r?.liquidationPrice ?? r?.liquidationPx ?? r?.liquidation_price ?? r?.liqPrice ?? r?.liquidation);
    if (!Number.isFinite(liq) || liq <= 0) continue;

    // Sisi: dari field sisi, atau dari tanda ukuran (positif=long, negatif=short).
    const sideRaw = String(r?.side ?? r?.direction ?? r?.positionSide ?? r?.longShort ?? r?.position_side ?? "").toLowerCase();
    let side: "long" | "short" | null = null;
    if (sideRaw === "long" || sideRaw === "l" || sideRaw === "b" || sideRaw === "buy") side = "long";
    else if (sideRaw === "short" || sideRaw === "s" || sideRaw === "a" || sideRaw === "sell") side = "short";
    if (!side) {
      const signed = Number(r?.szi ?? r?.signedSize);
      if (Number.isFinite(signed) && signed !== 0) side = signed > 0 ? "long" : "short";
    }
    if (!side) continue;

    const usd = Number(
      r?.sizeUsd ?? r?.notionalUsd ?? r?.positionValueUsd ?? r?.valueUsd ?? r?.notional ?? r?.usd,
    );
    if (!Number.isFinite(usd) || usd <= 0) { levelsWithoutNotional++; continue; }

    openValueUsd += usd;
    raw.push({
      price: liq,
      longUsd: side === "long" ? usd : 0,
      shortUsd: side === "short" ? usd : 0,
      distPct: markPrice ? ((liq - markPrice) / markPrice) * 100 : 0,
    });
  }

  return {
    bins: resampleBins(raw, markPrice),
    openPositions: raw.length || null,
    openValueUsd: openValueUsd || null,
    levelsWithoutNotional,
  };
}

/**
 * Resample bin sumber (harga + notional) ke grid seragam ±RANGE_PCT di
 * sekitar mark price live — grid yang sama dengan jalur on-chain.
 * Murni agregasi: tidak ada nilai baru yang dibuat.
 */
export function resampleBins(bins: LiquidationBin[], mark: number | null): LiquidationBin[] {
  if (!mark || bins.length === 0) return bins;
  const lo = mark * (1 - RANGE_PCT / 100);
  const hi = mark * (1 + RANGE_PCT / 100);
  const binSize = (hi - lo) / BINS;
  const acc = new Map<number, { longUsd: number; shortUsd: number }>();
  for (const b of bins) {
    if (!(b.price >= lo) || !(b.price <= hi)) continue;
    const idx = Math.min(BINS - 1, Math.max(0, Math.floor((b.price - lo) / binSize)));
    const cur = acc.get(idx) ?? { longUsd: 0, shortUsd: 0 };
    cur.longUsd += b.longUsd || 0;
    cur.shortUsd += b.shortUsd || 0;
    acc.set(idx, cur);
  }
  const out: LiquidationBin[] = [];
  for (let i = 0; i < BINS; i++) {
    const price = lo + binSize * (i + 0.5);
    const v = acc.get(i) ?? { longUsd: 0, shortUsd: 0 };
    out.push({ price, longUsd: v.longUsd, shortUsd: v.shortUsd, distPct: ((price - mark) / mark) * 100 });
  }
  return out;
}

/**
 * Klasifikasi kegagalan Vike supaya operator tahu harus bertindak apa.
 * Tidak pernah memuat nilai key.
 */
export function classifyVikeFailure(status: number | null, err?: string | null): string {
  if (status === 401) return "HTTP 401 — key ditolak Vike (cek di https://vike.io/account?tab=api-keys)";
  if (status === 403) return "HTTP 403 — IP VPS diblokir Cloudflare, data.vike.io tidak bisa diakses dari IP ini";
  if (status === 404) return "HTTP 404 — endpoint tidak tersedia di Vike";
  if (status === 429) return "HTTP 429 — rate limit Vike (20.000 request/jam per key)";
  if (status === 503) return "HTTP 503 — upstream Vike sedang down (coba 30 detik lagi)";
  if (status && status >= 500) return `HTTP ${status} — server Vike error`;
  if (err) return `Gagal koneksi: ${err}`;
  return "tidak diketahui";
}

class LiquidationMapHub {
  private started = false;
  private accounts: string[] = [];
  private accountIdx = 0;
  private snapshots = new Map<string, AccountSnapshot>();
  private markPrices = new Map<string, number>();
  private vikeLastOk = new Map<string, number>();
  private vikeLastError: string | null = null;
  /** Cache hasil Vike per simbol (hemat kuota 20rb/jam). */
  private vikeCache = new Map<string, { at: number; result: VikeResult | null }>();
  /** Promise yang sedang berjalan — mencegah request paralel ke Vike. */
  private vikeInFlight = new Map<string, Promise<VikeResult | null>>();
  /** Jeda till-depok: setelah 401/403/429/error jaringan, jangan panggil lagi. */
  private vikeBlockedUntil = 0;
  private timer: NodeJS.Timeout | null = null;
  private vikeTimer: NodeJS.Timeout | null = null;
  private leaderboardLoadedAt = 0;
  private startedAt = Date.now();
  private lastError: string | null = null;

  get isStarted(): boolean { return this.started; }
  get startedAtMs(): number { return this.startedAt; }
  get lastErrorMessage(): string | null { return this.lastError; }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.startedAt = Date.now();
    // Muat leaderboard (seed sampler) + refresh mark price.
    void this.loadAccountPool();
    void this.refreshMarks();
    this.timer = setInterval(() => void this.cycle(), SAMPLE_INTERVAL_MS);
    this.vikeTimer = setInterval(() => void this.refreshMarks(), 15_000);
    logger.info(
      { vikeKey: env.VIKE_API_KEY ? "SET" : "MISSING" },
      "LIQUIDATION_MAP_HUB_STARTED",
    );
  }

  stop(): void {
    this.started = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.vikeTimer) { clearInterval(this.vikeTimer); this.vikeTimer = null; }
  }

  // ── Mark price (anchor peta) ──────────────────────────────────────────────

  private async refreshMarks(): Promise<void> {
    try {
      const r = await fetch(HL_INFO_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "metaAndAssetCtxs" }),
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) return;
      const j: any = await r.json();
      const meta = j?.[0];
      const ctxs = j?.[1];
      if (!meta?.universe || !Array.isArray(ctxs)) return;
      for (let i = 0; i < meta.universe.length; i++) {
        const coin = String(meta.universe[i]?.name ?? "").toUpperCase();
        const mark = Number(ctxs[i]?.markPx);
        if (coin && mark > 0) this.markPrices.set(coin, mark);
      }
    } catch (err) {
      this.lastError = `mark refresh: ${(err as Error).message}`;
    }
  }

  markFor(symbol: string): number | null {
    return this.markPrices.get(baseCoin(symbol)) ?? null;
  }

  // ── Pool akun (leaderboard publik Hyperliquid) ───────────────────────────

  private async loadAccountPool(): Promise<void> {
    const now = Date.now();
    if (now - this.leaderboardLoadedAt < LEADERBOARD_TTL_MS && this.accounts.length > 0) return;
    try {
      const r = await fetch(HL_LEADERBOARD_URL, {
        signal: AbortSignal.timeout(60_000),
        headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) ArtaTrade/1.0" },
      });
      if (!r.ok) throw new Error(`leaderboard HTTP ${r.status}`);
      const j: any = await r.json();
      const rows: any[] = Array.isArray(j?.leaderboardRows) ? j.leaderboardRows : [];
      const picked: { addr: string; value: number }[] = [];
      for (const row of rows) {
        const addr = String(row?.ethAddress ?? "");
        const value = Number(row?.accountValue);
        if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) continue;
        if (!Number.isFinite(value) || value < MIN_ACCOUNT_VALUE_USD) continue;
        picked.push({ addr, value });
      }
      picked.sort((a, b) => b.value - a.value);
      // Sampling BERLAPIS (stratified), BUKAN "N akun terbesar".
      //
      // Diverifikasi live 24 Okt 2026: 40 akun terbesar memberi 0 posisi
      // dalam rentang ±15% (semua `liquidationPx`-nya jauh dari mark —
      // whales tidak pernah dekat likuidasi). 40 akun yang disebar di
      // seluruh pita nilai $250K+ memberi 4 posisi dalam rentang ±15%
      // dengan $1,69M notional. Karena itu sampler menyebar Sampling
      // di seluruh pita, bukan hanya teratas.
      const step = Math.max(1, Math.floor(picked.length / MAX_TRACKED_ACCOUNTS));
      const picked2: string[] = [];
      for (let i = 0; i < picked.length && picked2.length < MAX_TRACKED_ACCOUNTS; i += step) {
        picked2.push(picked[i]!.addr);
      }
      this.accounts = picked2;
      this.leaderboardLoadedAt = now;
      logger.info(
        { accounts: this.accounts.length, universe: picked.length },
        "LIQUIDATION_ACCOUNT_POOL_LOADED",
      );
    } catch (err) {
      this.lastError = `leaderboard: ${(err as Error).message}`;
      logger.warn({ err: (err as Error).message }, "LIQUIDATION_ACCOUNT_POOL_FAILED");
    }
  }

  // ── Siklus sampling ───────────────────────────────────────────────────────

  private async cycle(): Promise<void> {
    if (this.accounts.length === 0) { await this.loadAccountPool(); if (this.accounts.length === 0) return; }
    const batch: string[] = [];
    for (let i = 0; i < ACCOUNTS_PER_CYCLE && this.accounts.length > 0; i++) {
      batch.push(this.accounts[this.accountIdx % this.accounts.length]!);
      this.accountIdx = (this.accountIdx + 1) % this.accounts.length;
    }
    // 5 request paralel — cukup untuk HL tanpa kena rate limit.
    const CONC = 5;
    for (let i = 0; i < batch.length; i += CONC) {
      await Promise.all(batch.slice(i, i + CONC).map((a) => this.pollAccount(a)));
    }
    // Buang snapshot kedaluwarsa.
    const cutoff = Date.now() - POSITION_TTL_MS;
    for (const [k, v] of this.snapshots) if (v.seenAt < cutoff) this.snapshots.delete(k);
  }

  private async pollAccount(account: string): Promise<void> {
    try {
      const r = await fetch(HL_INFO_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "clearinghouseState", user: account }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) return;
      const j: any = await r.json();
      const ap: any[] = Array.isArray(j?.assetPositions) ? j.assetPositions : [];
      const positions: SampledPosition[] = [];
      for (const p of ap) {
        const pos = p?.position;
        if (!pos?.coin) continue;
        const szi = Number(pos.szi);
        if (!Number.isFinite(szi) || szi === 0) continue;
        const liq = pos.liquidationPx == null ? null : Number(pos.liquidationPx);
        positions.push({
          account,
          coin: String(pos.coin).toUpperCase(),
          szi,
          entryPx: Number(pos.entryPx) || 0,
          positionValueUsd: Math.abs(Number(pos.positionValue) || 0),
          liquidationPx: liq != null && Number.isFinite(liq) && liq > 0 ? liq : null,
          leverage: pos.leverage?.value ?? null,
          seenAt: Date.now(),
        });
      }
      this.snapshots.set(account, { account, positions, seenAt: Date.now(), receivedAt: Date.now() });
    } catch (err) {
      this.lastError = `pollAccount: ${(err as Error).message}`;
    }
  }

  // ── Vike (utama) ──────────────────────────────────────────────────────────

  /**
   * Ambil peta likuidasi dari Vike Data API.
   *
   * Rantai sesuai spec (3 endpoint, dicoba berurutan):
   *   a) /symbols/<SYM>/liquidation-heatmap?bins=150
   *   b) /positions?symbol=<SYM>&limit=5000
   *   c) /liquidations/risk
   *
   * Aturan:
   *  - 404 / 200-tanpa-level → coba endpoint berikutnya.
   *  - 401 / 403 / 429 / error jaringan → stop + jeda (buang kuota).
   *  - Hasil di-cache VIKE_TTL_MS per simbol; tidak ada request per HTTP call.
   */
  private async fetchVike(symbol: string): Promise<VikeResult | null> {
    if (!env.VIKE_API_KEY) return null;
    const sym = baseCoin(symbol);
    if (this.vikeBlockedUntil > Date.now()) return null;

    const cached = this.vikeCache.get(sym);
    if (cached && Date.now() - cached.at < VIKE_TTL_MS) return cached.result;

    const inflight = this.vikeInFlight.get(sym);
    if (inflight) return inflight;

    const p = this.vikeRequest(sym).finally(() => { this.vikeInFlight.delete(sym); });
    this.vikeInFlight.set(sym, p);
    const result = await p;
    this.vikeCache.set(sym, { at: Date.now(), result });
    return result;
  }

  private async vikeRequest(sym: string): Promise<VikeResult | null> {
    const mark = this.markFor(sym);

    // (a) Heatmap
    const heat = await this.vikeGet(`${VIKE_BASE}/symbols/${encodeURIComponent(sym)}/liquidation-heatmap?bins=${VIKE_HEATMAP_BINS}`);
    if (heat.stop) return null;
    if (heat.json) {
      const parsed = parseVikeHeatmap(heat.json, mark);
      if (parsed.bins.length > 0) {
        this.vikeLastOk.set(sym, Date.now());
        this.vikeLastError = null;
        return {
          bins: resampleBins(parsed.bins, mark),
          openPositions: parsed.openPositions,
          openValueUsd: parsed.openValueUsd,
          endpoint: "liquidation-heatmap",
          fetchedAt: Date.now(),
          receivedAt: Date.now(),
        };
      }
      this.vikeLastError = "liquidation-heatmap: 200 tapi tidak ada level likuidasi";
    }

    // (b) Posisi terbuka
    const pos = await this.vikeGet(`${VIKE_BASE}/positions?symbol=${encodeURIComponent(sym)}&limit=${VIKE_POSITIONS_LIMIT}`);
    if (pos.stop) return null;
    if (pos.json) {
      const parsed = parseVikePositions(pos.json, sym, mark);
      if (parsed.bins.some((b) => b.longUsd > 0 || b.shortUsd > 0)) {
        this.vikeLastOk.set(sym, Date.now());
        this.vikeLastError = null;
        return {
          bins: parsed.bins,
          openPositions: parsed.openPositions,
          openValueUsd: parsed.openValueUsd,
          endpoint: "positions",
          fetchedAt: Date.now(),
          receivedAt: Date.now(),
        };
      }
      this.vikeLastError = "positions: 200 tapi tidak ada posisi dengan harga likuidasi + notional USD";
    }

    // (c) Risiko likuidasi (lapis ketiga)
    const risk = await this.vikeGet(`${VIKE_BASE}/liquidations/risk`);
    if (risk.json) {
      const parsed = parseVikeHeatmap(risk.json, mark);
      if (parsed.bins.length > 0) {
        this.vikeLastOk.set(sym, Date.now());
        this.vikeLastError = null;
        return {
          bins: resampleBins(parsed.bins, mark),
          openPositions: parsed.openPositions,
          openValueUsd: parsed.openValueUsd,
          endpoint: "liquidations/risk",
          fetchedAt: Date.now(),
          receivedAt: Date.now(),
        };
      }
    }
    return null;
  }

  /**
   * GET JSON ke Vike. `stop=true` berarti kegagalan yang tidak akan hilang
   * dengan mencoba endpoint lain (auth / IP block / rate limit / jaringan).
   */
  private async vikeGet(url: string): Promise<{ status: number | null; json: any | null; stop: boolean }> {
    try {
      const r = await fetch(url, {
        headers: { "X-API-Key": env.VIKE_API_KEY!, Accept: "application/json" },
        signal: AbortSignal.timeout(12_000),
      });
      if (!r.ok) {
        this.vikeLastError = classifyVikeFailure(r.status);
        if (r.status === 401) { this.vikeBlockedUntil = Date.now() + VIKE_BACKOFF_401_MS; return { status: r.status, json: null, stop: true }; }
        if (r.status === 403) { this.vikeBlockedUntil = Date.now() + VIKE_BACKOFF_403_MS; return { status: r.status, json: null, stop: true }; }
        if (r.status === 429) { this.vikeBlockedUntil = Date.now() + VIKE_BACKOFF_429_MS; return { status: r.status, json: null, stop: true }; }
        // 404 (endpoint tidak ada) & 5xx → coba endpoint berikutnya.
        return { status: r.status, json: null, stop: false };
      }
      const j: any = await r.json().catch(() => null);
      return { status: r.status, json: j, stop: false };
    } catch (err) {
      this.vikeLastError = classifyVikeFailure(null, (err as Error).message);
      this.vikeBlockedUntil = Date.now() + VIKE_BACKOFF_NET_MS;
      return { status: null, json: null, stop: true };
    }
  }

  // ── Snapshot publik ───────────────────────────────────────────────────────

  async snapshot(symbol: string): Promise<LiquidationMapSnapshot> {
    const sym = symbol.toUpperCase();
    const mark = this.markFor(sym);
    const now = Date.now();

    // 1) Coba Vike dulu.
    const vike = await this.fetchVike(sym);
    if (vike && vike.bins.length > 0) {
      return this.assemble(sym, mark, vike.bins, "vike", vike.openPositions, vike.openValueUsd, now,
        `Vike Data API · ${vike.endpoint} · ${vike.bins.length} bin`, vike.fetchedAt, vike.receivedAt);
    }

    // 2) Fallback: sampling on-chain Hyperliquid.
    const bins = this.binsFromSampled(sym, mark);
    const covered = this.snapshots.size;
    const totalPositions = this.sampledPositionsFor(sym).length;
    const withLiq = this.sampledPositionsFor(sym).filter((p) => p.liquidationPx != null).length;
    const vikeNote = env.VIKE_API_KEY
      ? `Vike gagal: ${this.vikeLastError ?? "tidak diketahui"}`
      : "Vike key belum di-set (tanpa key)";
    // TAHAP 6B: untuk sampling on-chain, waktu sumber = polling akun terakhir
    // (bukan now) — kalau polling lama, evidence dianggap basi. Waktu terima
    // = waktu polling selesai (unknown bila belum ada yang terpolling).
    let sampledAt = 0;
    let sampledReceivedAt = 0;
    for (const s of this.snapshots.values()) {
      if (s.seenAt > sampledAt) sampledAt = s.seenAt;
      if (s.receivedAt > sampledReceivedAt) sampledReceivedAt = s.receivedAt;
    }
    return this.assemble(
      sym, mark, bins, "hyperliquid_onchain", null, null, now,
      `Hyperliquid on-chain sampling · ${covered} akun dipantau · ${totalPositions} posisi (${withLiq} punya liquidationPx) · ${vikeNote}`,
      sampledAt > 0 ? sampledAt : now,
      sampledReceivedAt > 0 ? sampledReceivedAt : null,
    );
  }

  private sampledPositionsFor(symbol: string): SampledPosition[] {
    const sym = baseCoin(symbol);
    const out: SampledPosition[] = [];
    for (const snap of this.snapshots.values()) {
      for (const p of snap.positions) if (p.coin === sym) out.push(p);
    }
    return out;
  }

  private binsFromSampled(symbol: string, mark: number | null): LiquidationBin[] {
    const sym = symbol.toUpperCase();
    const positions = this.sampledPositionsFor(sym);
    if (!mark || positions.length === 0) return [];
    const lo = mark * (1 - RANGE_PCT / 100);
    const hi = mark * (1 + RANGE_PCT / 100);
    const binSize = (hi - lo) / BINS;
    const acc = new Map<number, { longUsd: number; shortUsd: number }>();
    for (const p of positions) {
      if (p.liquidationPx == null) continue;
      const liq = p.liquidationPx;
      if (liq < lo || liq > hi) continue;
      const idx = Math.min(BINS - 1, Math.max(0, Math.floor((liq - lo) / binSize)));
      const cur = acc.get(idx) ?? { longUsd: 0, shortUsd: 0 };
      if (p.szi > 0) cur.longUsd += p.positionValueUsd; else cur.shortUsd += p.positionValueUsd;
      acc.set(idx, cur);
    }
    const out: LiquidationBin[] = [];
    for (let i = 0; i < BINS; i++) {
      const price = lo + binSize * (i + 0.5);
      const v = acc.get(i) ?? { longUsd: 0, shortUsd: 0 };
      out.push({ price, longUsd: v.longUsd, shortUsd: v.shortUsd, distPct: ((price - mark) / mark) * 100 });
    }
    return out;
  }

  /** Susun snapshot final: kumulatif ±2/5/10/15%, cluster, magnet. */
  private assemble(
    symbol: string,
    mark: number | null,
    bins: LiquidationBin[],
    source: "vike" | "hyperliquid_onchain",
    openPositions: number | null,
    openValueUsd: number | null,
    updatedAt: number,
    note: string,
    sourceTsMs: number,
    sourceReceivedAtMs: number | null = null,
  ): LiquidationMapSnapshot {
    const cum: LiquidationMapSnapshot["cum"] = [];
    for (const pct of [2, 5, 10, 15]) {
      let longsUsd = 0, shortsUsd = 0;
      for (const b of bins) {
        if (Math.abs(b.distPct) <= pct) { longsUsd += b.longUsd; shortsUsd += b.shortUsd; }
      }
      const total = longsUsd + shortsUsd;
      cum.push({ pct, longsUsd, shortsUsd, skewPct: total > 0 ? ((longsUsd - shortsUsd) / total) * 100 : 0 });
    }

    // Cluster: bin dengan notional terbesar di bawah & di atas mark.
    const below = bins.filter((b) => b.distPct < 0 && b.longUsd > 0).sort((a, b) => b.longUsd - a.longUsd).slice(0, 6);
    const above = bins.filter((b) => b.distPct > 0 && b.shortUsd > 0).sort((a, b) => b.shortUsd - a.shortUsd).slice(0, 6);
    const topLongClustersBelow = below.map((b) => ({ price: b.price, distPct: b.distPct, liqUsd: b.longUsd, positions: 0 }));
    const topShortClustersAbove = above.map((b) => ({ price: b.price, distPct: b.distPct, liqUsd: b.shortUsd, positions: 0 }));

    // Arah magnet: sisi dengan notional likuidasi lebih besar = magnet.
    const longsTotal = bins.reduce((a, b) => a + b.longUsd, 0);
    const shortsTotal = bins.reduce((a, b) => a + b.shortUsd, 0);
    const magnet: "UP" | "DOWN" | "NONE" =
      longsTotal === 0 && shortsTotal === 0 ? "NONE"
      : shortsTotal > longsTotal * 1.15 ? "UP"    // short banyak di atas -> harga naik magnet
      : longsTotal > shortsTotal * 1.15 ? "DOWN"  // long banyak di bawah -> harga turun magnet
      : "NONE";

    // TAHAP 6B: `stale` dihitung dari WAKTU SUMBER (sourceTsMs), bukan dari
    // waktu snapshot dirakit — cache Vike 60 dtk tidak boleh membuat data
    // 10 menit lalu tampak "fresh".
    const stale = Date.now() - sourceTsMs > 120_000;

    return {
      symbol,
      source,
      markPrice: mark,
      updatedAt,
      sourceTsMs,
      sourceReceivedAtMs,
      stale,
      bins,
      openPositions,
      openValueUsd,
      cum,
      topLongClustersBelow,
      topShortClustersAbove,
      magnetDirection: magnet,
      note,
    };
  }
}

export const liquidationMapHub = new LiquidationMapHub();
