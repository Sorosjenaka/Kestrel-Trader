// apps/server/src/markets/binanceFuturesClient.ts
// Klien data Binance USDT-M FUTURES ONLY — SEMUA harga website wajib LIVE dari sini.
//
// Kebijakan operator: HANYA futures, TANPA fallback spot. Bila feed futures
// terputus, harga dinyatakan STALE (isPriceLive=false) dan entry DIBLOKIR —
// tidak ada harga pengganti dari pasar lain.
//
// Desain anti-ban (Binance menegur: "use the websocket for live updates"):
//  1. WS Futures `!markPrice@arr@1s` (SATU koneksi utk SEMUA simbol, via WsMarkPriceManager)
//     -> mark price / index / funding ASLI Binance Futures, real-time ~1 dtk.
//  2. REST Futures HANYA snapshot hemat: full 24hr max 1x/60 dtk via RestPool (rotasi
//     fapi1..fapi4 + fapi, circuit breaker, retry). Kena 418/429/403/451 -> cooldown 5 mnt.
//  3. Hot path (SSE 1 dtk, /api/prices/*, ticker per-simbol) 100% dari cache WS merged —
//     NOL request REST, sehingga IP tidak akan kena ban lagi.
import { env } from "../core/env.js";
import { binanceRest } from "../marketdata/restPool.js";
import { WsMarkPriceManager } from "../marketdata/wsManager.js";
import { isPerpListed } from "../universe/assetClassGuard.js";
import { defaultMarketsService, RawTicker24h } from "./marketsService.js";

export interface BinanceFuturesTickerRaw {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  quoteVolume: string;
  highPrice: string;
  lowPrice: string;
  openPrice: string;
}

export interface BinancePremiumIndexRaw {
  symbol: string;
  markPrice: string;
  indexPrice: string;
  estimatedSettlePrice: string;
  lastFundingRate: string;
  interestRate: string;
  nextFundingTime: number;
  time: number;
}

export type PriceSrc = "FUTURES";

export interface BinancePairMeta {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  price: number;
  markPrice: number;
  indexPrice: number;
  chg24h: number;
  vol24hUsd: number;
  high24h: number;
  low24h: number;
  fundingRate: number;
  nextFundingTime: number;
  category: "MAJOR" | "LAYER 1" | "DEFI" | "MEME" | "AI" | "ALT";
  /** Selalu FUTURES — tidak ada sumber lain. */
  src?: PriceSrc;
}

export interface LiveTickerSnapshot {
  symbol: string;
  lastPrice: number;
  markPrice: number;
  indexPrice: number;
  chg24hPct: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  fundingRate: number;
  nextFundingTime: number;
  direction: "UP" | "DOWN" | "FLAT";
  lastUpdated: number;
  /** Selalu FUTURES — tidak ada sumber lain. */
  src?: PriceSrc;
  /** True bila angka berasal dari feed futures live (bukan seed placeholder). */
  live?: boolean;
}

interface FeedState {
  last: number;
  mark: number;
  index: number;
  funding: number | null;
  chg: number;
  high: number;
  low: number;
  qvol: number;
  futuresAt: number;
  restAt: number;
}

const FULL_SNAPSHOT_MIN_MS = 60_000;
const PER_SYMBOL_REST_MIN_MS = 30_000;
// Cooldown 3 mnt saat kena 418/429 (sebelumnya 5 mnt yang bikin MTF_UNAVAILABLE
// massal + slot kosong lama; pacing MTF kini mencegah 429 berulang).
const FUTURES_REST_COOLDOWN_MS = 3 * 60_000;
export function klineCacheTtlMs(interval: string): number {
  if (interval === "3m") return 60_000; // TF konfirmasi (28 Sep 2026): lebih jarang berubah daripada 1m, tetap <=1 lilin.
  if (interval === "5m") return 90_000;
  if (interval === "15m") return 180_000;
  if (interval === "1h") return 300_000;
  if (interval === "4h") return 600_000;
  return 0; // 1m trigger must always be fetched fresh.
}
const WS_FRESH_MS = 4_000;
const SYMBOL_RE = /^[A-Z0-9]{2,12}USDT$/;

function categorize(sym: string): BinancePairMeta["category"] {
  if (["BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT"].includes(sym)) return "MAJOR";
  if (["SOLUSDT", "SUIUSDT", "AVAXUSDT", "NEARUSDT", "ARBUSDT", "OPUSDT", "TIAUSDT", "SEIUSDT", "APTUSDT"].includes(sym)) return "LAYER 1";
  if (["DOGEUSDT", "PEPEUSDT", "WIFUSDT", "1000PEPEUSDT", "1000SHIBUSDT", "1000BONKUSDT", "FLOKIUSDT", "BONKUSDT", "SHIBUSDT"].includes(sym)) return "MEME";
  if (["RENDERUSDT", "FETUSDT", "TAOUSDT", "WLDUSDT", "IOUSDT"].includes(sym)) return "AI";
  if (["LINKUSDT", "AAVEUSDT", "UNIUSDT", "CRVUSDT", "MKRUSDT", "PENDLEUSDT", "LDOUSDT"].includes(sym)) return "DEFI";
  return "ALT";
}

/*
   23 Okt 2026: diekspor supaya test bisa menguji getHubPrices() langsung
   (bukan replika logika) — kontrak payload hub dikunci di
   tests/hubFundingRate.test.ts.
*/
export class BinanceFuturesClient {
  private cachedTickers: BinanceFuturesTickerRaw[] = [];
  private cachedPairs: BinancePairMeta[] = [];
  private pairIndex: Map<string, BinancePairMeta> = new Map();
  private cachedLiveTickers: Map<string, LiveTickerSnapshot> = new Map();
  private previousPrices: Map<string, number> = new Map();
  // Timestamp sukses feed futures terakhir per simbol — bedakan harga LIVE vs basi/seed.
  private liveAt: Map<string, number> = new Map();
  private lastFetchedAt: number = 0;
  private lastSnapshotAttempt: number = 0;
  private futuresRestCooldownUntil: number = 0;
  private klineCache = new Map<string, { at: number; rows: any[] }>();
  private pendingKlines = new Map<string, Promise<any[]>>();
  private perSymbolRestAt: Map<string, number> = new Map();
  private isFetching: boolean = false;
  private autoSyncTimer: NodeJS.Timeout | null = null;
  private snapshotTimer: NodeJS.Timeout | null = null;
  private tickerListeners: Set<(pairs: BinancePairMeta[]) => void> = new Set();

  // ── Live feed futures (WS mark price + REST snapshot) ────────────────────
  private feed: Map<string, FeedState> = new Map();
  private feedsStarted: boolean = false;
  private futuresWs: WsMarkPriceManager | null = null;
  private futuresWsLiveAt: number = 0;
  private futuresWsSymbols: number = 0;
  private lastPublishAt: number = 0;

  constructor() {
    this.seedInitialPairs();
  }

  public onTickersUpdated(listener: (pairs: BinancePairMeta[]) => void): () => void {
    this.tickerListeners.add(listener);
    return () => {
      this.tickerListeners.delete(listener);
    };
  }

  public startAutoSync(intervalMs = 3000): void {
    this.startLiveFeeds();
    if (this.autoSyncTimer) return;
    // Timer hemat: fetchReal24hTickers() menolak sendiri bila < 60 dtk sejak snapshot
    // terakhir, sehingga interval kecil dari pemanggil TIDAK menghantam REST lagi.
    this.fetchReal24hTickers(true).catch(() => {});
    this.autoSyncTimer = setInterval(() => {
      this.fetchReal24hTickers(false).catch(() => {});
    }, Math.max(intervalMs, 15_000));
  }

  public stopAutoSync(): void {
    if (this.autoSyncTimer) {
      clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // LIVE FEED FUTURES — 1x WS !markPrice@arr@1s + snapshot REST hemat.
  // ═══════════════════════════════════════════════════════════════════════

  /** Nyalakan WS futures + snapshot REST hemat. Idempotent — aman dipanggil berkali-kali. */
  public startLiveFeeds(): void {
    if (this.feedsStarted) return;
    this.feedsStarted = true;
    this.startFuturesWs();
    if (!this.snapshotTimer) {
      this.snapshotTimer = setInterval(() => {
        this.fetchReal24hTickers(false).catch(() => {});
      }, 30_000);
    }
    // Snapshot awal agar katalog pair + statistik 24h terisi walau WS butuh bbrp detik.
    this.fetchReal24hTickers(true).catch(() => {});
  }

  private startFuturesWs(): void {
    if (this.futuresWs) return;
    try {
      this.futuresWs = new WsMarkPriceManager({
        hosts: [env.BINANCE_WS_PRIMARY, env.BINANCE_WS_FALLBACK],
        // Toleransi jaringan ID (proxy sering stall 2-4 dtk; handshake bisa >8 dtk):
        // gap 8 dtk baru resubscribe, quarantine 10 dtk, handshake diberi 20 dtk
        // (guard 8 dtk TERBUKTI membunuh handshake lambat yang valid -> badai
        // "closed before established" + throttle). (Default lib tetap 2s/5s/8s.)
        gapLimitMs: 8000,
        quarantineMs: 10000,
        connectTimeoutMs: 20000,
        handlers: {
          mark: (m) => this.applyFuturesMark(m?.symbol, m?.markPrice, m?.indexPrice, m?.fundingRate),
          batch: (b) => {
            if (b && typeof b.count === "number" && b.count > 0) {
              this.futuresWsLiveAt = Date.now();
            }
          },
        },
      });
      this.futuresWs.start();
    } catch {
      this.futuresWs = null;
    }
  }

  private applyFuturesMark(symbol: unknown, mark: unknown, index: unknown, funding: unknown): void {
    if (typeof symbol !== "string" || !SYMBOL_RE.test(symbol)) return;
    // ONLY FUTURES: abaikan mark simbol di luar allowlist PERPETUAL (spot/delivery).
    // Fail-open bila allowlist kosong (belum sync).
    if (isPerpListed(symbol) === false) return;
    const mp = Number(mark);
    if (!Number.isFinite(mp) || mp <= 0) return;
    const now = Date.now();
    let st = this.feed.get(symbol);
    if (!st) {
      st = { last: 0, mark: 0, index: 0, funding: null, chg: 0, high: 0, low: 0, qvol: 0, futuresAt: 0, restAt: 0 };
      this.feed.set(symbol, st);
    }
    st.mark = mp;
    const iv = Number(index);
    if (Number.isFinite(iv) && iv > 0) st.index = iv;
    /*
       23 Okt 2026 (BUG): Number(null) = 0 dan Number.isFinite(0) = true, jadi
       funding "tidak ada" tersimpan sebagai 0 — yang berarti "funding netral".
       Dua hal berbeda: null = tidak ada data, 0 = netral. Sumber WS tidak
       selalu mengirim field "r" (symbol yang baru masuk allowlist, dsb),
       jadi null HARUS dipertahankan.
    */
    if (funding !== null && funding !== undefined) {
      const fr = Number(funding);
      if (Number.isFinite(fr)) st.funding = fr;
    }
    st.futuresAt = now;
    this.futuresWsLiveAt = now;
    this.liveAt.set(symbol, now);
    // Sinkronkan katalog pair O(1) via index — harga terminal/modal pair ikut live.
    const pair = this.pairIndex.get(symbol);
    if (pair) {
      pair.markPrice = mp;
      if (st.index > 0) pair.indexPrice = st.index;
      if (st.funding !== null) pair.fundingRate = st.funding;
      if (st.last <= 0) pair.price = mp;
      pair.src = "FUTURES";
    }
    const snap = this.cachedLiveTickers.get(symbol);
    if (snap) {
      const prev = this.previousPrices.get(symbol) ?? snap.markPrice;
      snap.markPrice = mp;
      if (st.index > 0) snap.indexPrice = st.index;
      if (st.funding !== null) snap.fundingRate = st.funding;
      snap.direction = mp > prev ? "UP" : mp < prev ? "DOWN" : snap.direction;
      snap.lastUpdated = now;
      snap.src = "FUTURES";
      snap.live = true;
      this.previousPrices.set(symbol, mp);
    }
    this.futuresWsSymbols = this.feed.size;
    this.maybePublish();
  }

  /** Dorong tick WS ke marketsService + listener SSE max 1x/5 dtk (hemat, ranking stabil). */
  private maybePublish(): void {
    const now = Date.now();
    if (now - this.lastPublishAt < 5000) return;
    this.lastPublishAt = now;
    try {
      const rawList: RawTicker24h[] = this.cachedPairs.map((p) => ({
        symbol: p.symbol,
        lastPrice: p.markPrice > 0 ? p.markPrice : p.price,
        priceChangePercent: p.chg24h,
        quoteVolume: p.vol24hUsd,
        regime: Math.abs(p.chg24h) > 8 ? "VOLATILE" : Math.abs(p.chg24h) > 2 ? "TRENDING" : "RANGING",
        eligible: p.vol24hUsd > env.VOLUME_MIN_USD,
        eligibleReason: p.vol24hUsd <= env.VOLUME_MIN_USD ? "VOLUME_BELOW_MIN" : null,
      }));
      if (rawList.length > 0) {
        defaultMarketsService.setTickers(rawList, now);
        this.lastFetchedAt = now;
      }
      for (const listener of this.tickerListeners) {
        try {
          listener(this.cachedPairs);
        } catch {}
      }
    } catch {}
  }

  /** Status feed untuk badge LIVE di UI + diagnosis. */
  public getFeedHealth(): {
    futuresWs: { connected: boolean; ageMs: number; symbols: number; status: string; url: string | null; reconnects: number; gaps: number; connects: number; messages: number; lastError: string | null; lastCloseCode: number | null; dryStreak: number };
    rest: { cooldownMs: number; lastSnapshotAt: number; universeSrc: PriceSrc };
    liveSymbols: number;
    totalSymbols: number;
  } {
    const now = Date.now();
    const futAge = this.futuresWsLiveAt > 0 ? now - this.futuresWsLiveAt : -1;
    const wsHealth = this.futuresWs?.health() ?? null;
    let live = 0;
    this.feed.forEach((st) => {
      if (now - Math.max(st.futuresAt, st.restAt) < 10_000 && (st.mark > 0 || st.last > 0)) live++;
    });
    return {
      futuresWs: {
        connected: futAge >= 0 && futAge < 8000,
        ageMs: futAge,
        symbols: this.futuresWsSymbols,
        status: wsHealth?.status ?? "STOPPED",
        url: wsHealth?.url ?? null,
        reconnects: wsHealth?.reconnects ?? 0,
        gaps: wsHealth?.gaps ?? 0,
        connects: wsHealth?.connects ?? 0,
        messages: wsHealth?.messages ?? 0,
        lastError: wsHealth?.lastError ?? null,
        lastCloseCode: wsHealth?.lastCloseCode ?? null,
        dryStreak: wsHealth?.dryStreak ?? 0,
      },
      rest: {
        cooldownMs: Math.max(0, this.futuresRestCooldownUntil - now),
        lastSnapshotAt: this.lastFetchedAt,
        universeSrc: "FUTURES",
      },
      liveSymbols: live,
      totalSymbols: this.cachedPairs.length,
    };
  }

  private seedInitialPairs(): void {
    const seeds: Array<{ s: string; b: string; p: number; chg: number; volM: number; cat: BinancePairMeta["category"] }> = [
      { s: "BTCUSDT", b: "BTC", p: 65420.5, chg: 3.8, volM: 1250, cat: "MAJOR" },
      { s: "ETHUSDT", b: "ETH", p: 3450.2, chg: 5.2, volM: 680, cat: "MAJOR" },
      { s: "SOLUSDT", b: "SOL", p: 152.4, chg: 14.6, volM: 420, cat: "LAYER 1" },
      { s: "BNBUSDT", b: "BNB", p: 585.1, chg: 2.1, volM: 160, cat: "MAJOR" },
      { s: "DOGEUSDT", b: "DOGE", p: 0.124, chg: 11.2, volM: 180, cat: "MEME" },
      { s: "XRPUSDT", b: "XRP", p: 0.582, chg: 3.1, volM: 85, cat: "MAJOR" },
      { s: "SUIUSDT", b: "SUI", p: 1.84, chg: 18.2, volM: 140, cat: "LAYER 1" },
      { s: "PEPEUSDT", b: "PEPE", p: 0.0000084, chg: 22.4, volM: 210, cat: "MEME" },
      { s: "WIFUSDT", b: "WIF", p: 2.45, chg: 16.5, volM: 110, cat: "MEME" },
      { s: "NEARUSDT", b: "NEAR", p: 5.42, chg: 9.8, volM: 95, cat: "LAYER 1" },
      { s: "AVAXUSDT", b: "AVAX", p: 28.6, chg: 7.4, volM: 88, cat: "LAYER 1" },
      { s: "LINKUSDT", b: "LINK", p: 12.1, chg: 4.5, volM: 52, cat: "DEFI" },
      { s: "RENDERUSDT", b: "RENDER", p: 6.25, chg: 13.9, volM: 58, cat: "AI" },
      { s: "FETUSDT", b: "FET", p: 1.48, chg: 15.3, volM: 65, cat: "AI" },
      { s: "AAVEUSDT", b: "AAVE", p: 142.5, chg: 10.4, volM: 62, cat: "DEFI" },
      { s: "ARBUSDT", b: "ARB", p: 0.59, chg: 6.8, volM: 35, cat: "LAYER 1" },
      { s: "OPUSDT", b: "OP", p: 1.62, chg: 8.1, volM: 31, cat: "LAYER 1" },
      { s: "TIAUSDT", b: "TIA", p: 5.85, chg: -8.7, volM: 44, cat: "LAYER 1" },
      { s: "TAOUSDT", b: "TAO", p: 480.0, chg: 19.8, volM: 92, cat: "AI" },
      { s: "INJUSDT", b: "INJ", p: 21.4, chg: 8.7, volM: 45, cat: "DEFI" },
      { s: "RUNEUSDT", b: "RUNE", p: 4.82, chg: 7.9, volM: 38, cat: "DEFI" },
      { s: "MATICUSDT", b: "MATIC", p: 0.412, chg: 6.2, volM: 32, cat: "LAYER 1" },
      { s: "ADAUSDT", b: "ADA", p: 0.365, chg: 4.1, volM: 41, cat: "LAYER 1" },
      { s: "DOTUSDT", b: "DOT", p: 4.62, chg: 5.5, volM: 29, cat: "LAYER 1" },
      { s: "LDOUSDT", b: "LDO", p: 1.25, chg: 7.1, volM: 22, cat: "DEFI" },
      { s: "TRUMPUSDT", b: "TRUMP", p: 14.2, chg: -16.8, volM: 54, cat: "MEME" },
      { s: "HMSTRUSDT", b: "HMSTR", p: 0.0054, chg: -14.2, volM: 42, cat: "MEME" },
      { s: "CATIUSDT", b: "CATI", p: 0.52, chg: -12.5, volM: 33, cat: "MEME" },
      { s: "NOTUSDT", b: "NOT", p: 0.0078, chg: -11.4, volM: 48, cat: "MEME" },
      { s: "DOGSUSDT", b: "DOGS", p: 0.00082, chg: -10.1, volM: 28, cat: "MEME" },
      { s: "SEIUSDT", b: "SEI", p: 0.42, chg: -9.5, volM: 36, cat: "LAYER 1" },
      { s: "STXUSDT", b: "STX", p: 1.82, chg: -8.1, volM: 27, cat: "LAYER 1" },
      { s: "KASUSDT", b: "KAS", p: 0.142, chg: -7.6, volM: 21, cat: "ALT" },
      { s: "FLOKIUSDT", b: "FLOKI", p: 0.000145, chg: -7.2, volM: 39, cat: "MEME" },
      { s: "BONKUSDT", b: "BONK", p: 0.000021, chg: -6.8, volM: 45, cat: "MEME" },
      { s: "FTMUSDT", b: "FTM", p: 0.65, chg: -6.2, volM: 24, cat: "LAYER 1" },
      { s: "GALAUSDT", b: "GALA", p: 0.022, chg: -5.9, volM: 19, cat: "ALT" },
      { s: "APTUSDT", b: "APT", p: 8.92, chg: 12.1, volM: 75, cat: "LAYER 1" },
      { s: "CRVUSDT", b: "CRV", p: 0.28, chg: 4.8, volM: 18, cat: "DEFI" },
      { s: "UNIUSDT", b: "UNI", p: 6.84, chg: 5.1, volM: 34, cat: "DEFI" },
      { s: "1000PEPEUSDT", b: "1000PEPE", p: 0.0084, chg: 22.4, volM: 190, cat: "MEME" },
      { s: "1000BONKUSDT", b: "1000BONK", p: 0.021, chg: -6.8, volM: 42, cat: "MEME" },
      { s: "1000SHIBUSDT", b: "1000SHIB", p: 0.0145, chg: 3.4, volM: 65, cat: "MEME" },
    ];

    // Seed = placeholder awal saja (BUKAN harga live); langsung ditimpa WS/REST
    // futures dalam ~1-2 detik setelah boot. Jangan pernah dianggap harga live.
    this.cachedPairs = seeds.map((s) => ({
      symbol: s.s,
      baseAsset: s.b,
      quoteAsset: "USDT",
      price: s.p,
      markPrice: s.p,
      indexPrice: s.p,
      chg24h: s.chg,
      vol24hUsd: s.volM * 1_000_000,
      high24h: Number((s.p * 1.05).toFixed(4)),
      low24h: Number((s.p * 0.95).toFixed(4)),
      fundingRate: 0.0001,
      nextFundingTime: Date.now() + 14400000,
      category: s.cat,
      src: "FUTURES" as PriceSrc,
    }));
    this.rebuildPairIndex();
    this.lastFetchedAt = 0;
  }

  private rebuildPairIndex(): void {
    this.pairIndex.clear();
    for (const p of this.cachedPairs) this.pairIndex.set(p.symbol, p);
  }

  /**
   * REST futures via RestPool resmi (rotasi fapi1..fapi4+fapi, circuit breaker, retry).
   * Satu-satunya jalur REST yang diizinkan — tidak ada mirror/endpoint pasar lain.
   */
  private async requestFapi(path: string, timeoutMs?: number): Promise<any> {
    const r = await binanceRest.get<any>(path, undefined, timeoutMs);
    return r.data;
  }

  /**
   * Aturan trading simbol dari /fapi/v1/exchangeInfo Binance Futures:
   * tickSize (presisi harga), stepSize (presisi qty), minNotional.
   * 23 Okt 2026: dipakai route /api/binance/symbol-info supaya chart
   * menampilkan harga pair kecil dengan presisi BENAR (0.0187, bukan 0.02).
   */
  public async fetchSymbolInfo(symbol: string): Promise<{ symbol: string; tickSize: number; stepSize: number; minNotional: number; pricePrecision: number } | null> {
    const sym = String(symbol || "").toUpperCase();
    if (!/^[A-Z0-9]{2,20}USDT$/.test(sym)) return null;
    try {
      const info = await this.requestFapi("/fapi/v1/exchangeInfo", 10_000);
      const list: any[] = Array.isArray(info?.symbols) ? info.symbols : [];
      const s = list.find((x) => x?.symbol === sym);
      if (!s) return null;
      /*
         Struktur Binance Futures: tickSize/stepSize/minNotional berada di
         array `filters` (filterType PRICE_FILTER / LOT_SIZE / MIN_NOTIONAL),
         BUKAN di field top-level symbol. (Versi pertama salah baca s.priceFilter
         -> selalu kosong -> tickSize fallback 0.01 -> harga pair kecil salah.)
      */
      const filters: any[] = Array.isArray(s.filters) ? s.filters : [];
      const priceFilter = filters.find((f) => f?.filterType === "PRICE_FILTER") ?? {};
      const lotSize = filters.find((f) => f?.filterType === "LOT_SIZE") ?? {};
      const minNotionalFilter = filters.find((f) => f?.filterType === "MIN_NOTIONAL") ?? {};
      const tickSize = Number(priceFilter.tickSize);
      const pricePrecision = Number.isFinite(Number(s.pricePrecision))
        ? Number(s.pricePrecision)
        : (Number.isFinite(tickSize) && tickSize > 0 ? Math.max(0, Math.round(-Math.log10(tickSize))) : 2);
      return {
        symbol: sym,
        tickSize: Number.isFinite(tickSize) && tickSize > 0 ? tickSize : 0.01,
        stepSize: Number(lotSize.stepSize) > 0 ? Number(lotSize.stepSize) : 0.001,
        minNotional: Number(minNotionalFilter.notional ?? lotSize.minNotional) > 0
          ? Number(minNotionalFilter.notional ?? lotSize.minNotional)
          : 5,
        pricePrecision,
      };
    } catch {
      return null;
    }
  }

  /**
   * Order book depth publik (14 Okt 2026 — heatmap likuiditas/order book).
   * /fapi/v1/depth, limit maks 1000. Tanpa cache agresif — heatmap butuh segar.
   */
  public async fetchDepth(symbol: string, limit = 500): Promise<{ bids: [string, string][]; asks: [string, string][] }> {
    const lim = Math.min(1000, Math.max(5, Math.round(limit)));
    const data = await this.requestFapi(`/fapi/v1/depth?symbol=${encodeURIComponent(symbol.toUpperCase())}&limit=${lim}`, 8000);
    return { bids: data?.bids ?? [], asks: data?.asks ?? [] };
  }

  public async fetchKlines(symbol: string, interval = "15m", limit = 100, startTime?: number, endTime?: number): Promise<any[]> {
    const sym = symbol.toUpperCase();
    const key = `${sym}:${interval}:${limit}:${startTime ?? ""}:${endTime ?? ""}`;
    const ttl = klineCacheTtlMs(interval);
    const cached = this.klineCache.get(key);
    if (ttl && cached && Date.now() - cached.at < ttl) return cached.rows;
    const pending = this.pendingKlines.get(key);
    if (pending) return pending;
    // Fast-fail saat REST di-cooldown (ban/limit): JANGAN bakar retry sia-sia yang
    // memperlama scan + memperpanjang ban. Penelepon memakai cache/fallback.
    if (Date.now() < this.futuresRestCooldownUntil) return [];
    const request = (async () => {
      try {
        const range = `${startTime !== undefined ? `&startTime=${Math.floor(startTime)}` : ""}${endTime !== undefined ? `&endTime=${Math.floor(endTime)}` : ""}`;
        const data = await this.requestFapi(`/fapi/v1/klines?symbol=${encodeURIComponent(sym)}&interval=${interval}&limit=${limit}${range}`, 10_000);
        if (Array.isArray(data)) {
          if (ttl) {
            this.klineCache.set(key, { at: Date.now(), rows: data });
            if (this.klineCache.size > 900) {
              const oldest = [...this.klineCache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 200);
              for (const [oldKey] of oldest) this.klineCache.delete(oldKey);
            }
          }
          return data;
        }
      } catch (err) {
        this.noteRestFailure(err);
      }
      return [];
    })();
    this.pendingKlines.set(key, request);
    try { return await request; }
    finally { this.pendingKlines.delete(key); }
  }

  /** Historical, timestamp-bounded OHLC for forensic review; this is read-only and never submits orders. */
  public async fetchKlinesRange(symbol: string, interval: "1m" | "5m", startTime: number, endTime: number, limit = 1000): Promise<any[]> {
    const sym = symbol.toUpperCase();
    if (!SYMBOL_RE.test(sym) || ![startTime, endTime].every(Number.isFinite) || startTime < 0 || endTime <= startTime) return [];
    const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
    const key = `${sym}:${interval}:${startTime}:${endTime}:${safeLimit}`;
    const pending = this.pendingKlines.get(key);
    if (pending) return pending;
    if (Date.now() < this.futuresRestCooldownUntil) return [];
    const request = (async () => {
      try {
        const query = new URLSearchParams({ symbol: sym, interval, startTime: String(Math.floor(startTime)), endTime: String(Math.floor(endTime)), limit: String(safeLimit) });
        const data = await this.requestFapi(`/fapi/v1/klines?${query.toString()}`, 12_000);
        return Array.isArray(data) ? data : [];
      } catch (err) {
        this.noteRestFailure(err);
        return [];
      }
    })();
    this.pendingKlines.set(key, request);
    try { return await request; }
    finally { this.pendingKlines.delete(key); }
  }

  /**
   * GET publik ke fapi (dipakai UniverseManager.syncOnce — FR-01).
   * Memakai RestPool yang sama (timeout + rotasi host + circuit breaker).
   */
  public async fetchPublic<T>(path: string): Promise<{ data: T }> {
    const data = await this.requestFapi(path);
    return { data: data as T };
  }

  private snapshotFromFeed(sym: string, now: number): LiveTickerSnapshot | null {
    const st = this.feed.get(sym);
    if (!st) return null;
    const freshMs = now - Math.max(st.futuresAt, st.restAt);
    const mark = st.mark > 0 ? st.mark : st.last;
    const last = st.last > 0 ? st.last : mark;
    if (!(mark > 0)) return null;
    const prev = this.previousPrices.get(sym) ?? this.cachedLiveTickers.get(sym)?.markPrice ?? mark;
    const direction: "UP" | "DOWN" | "FLAT" = mark > prev ? "UP" : mark < prev ? "DOWN" : "FLAT";
    this.previousPrices.set(sym, mark);
    const snap: LiveTickerSnapshot = {
      symbol: sym,
      lastPrice: last,
      markPrice: mark,
      indexPrice: st.index > 0 ? st.index : mark,
      chg24hPct: st.chg,
      high24h: st.high > 0 ? st.high : mark * 1.02,
      low24h: st.low > 0 ? st.low : mark * 0.98,
      volume24h: st.qvol,
      fundingRate: st.funding ?? 0.0001,
      nextFundingTime: now + 14400000,
      direction,
      lastUpdated: Math.max(st.futuresAt, st.restAt, now - freshMs),
      src: "FUTURES",
      live: freshMs < 15_000,
    };
    this.cachedLiveTickers.set(sym, snap);
    return snap;
  }

  /**
   * Ticker live per simbol — UTAMA dari cache WS futures (0 REST bila segar).
   * REST per-simbol hanya sebagai pilihan terakhir, max 1x/30 dtk/simbol, dan
   * dihormati cooldown saat futures di-ban. TIDAK ADA fallback pasar lain:
   * bila futures putus, kembalikan cache terakhir bertanda live=false / null.
   */
  public async fetchSymbolTicker(symbol: string): Promise<LiveTickerSnapshot | null> {
    const sym = symbol.toUpperCase();
    const now = Date.now();

    const fast = this.snapshotFromFeed(sym, now);
    if (fast && (fast.live || now - Math.max(this.feed.get(sym)?.futuresAt ?? 0, this.feed.get(sym)?.restAt ?? 0) < 120_000)) {
      this.liveAt.set(sym, now);
      return fast;
    }

    const lastRest = this.perSymbolRestAt.get(sym) ?? 0;
    if (now - lastRest < PER_SYMBOL_REST_MIN_MS) {
      if (fast) return fast;
      const cached = this.cachedLiveTickers.get(sym);
      if (cached) return cached;
      return this.snapshotFromSeed(sym, now);
    }
    if (now < this.futuresRestCooldownUntil) {
      if (fast) return fast;
      const cached = this.cachedLiveTickers.get(sym);
      if (cached) return { ...cached, live: false };
      return this.snapshotFromSeed(sym, now);
    }

    try {
      this.perSymbolRestAt.set(sym, now);
      const [t24, prem] = await Promise.allSettled([
        this.requestFapi(`/fapi/v1/ticker/24hr?symbol=${encodeURIComponent(sym)}`),
        this.requestFapi(`/fapi/v1/premiumIndex?symbol=${encodeURIComponent(sym)}`),
      ]);

      const t24Data = t24.status === "fulfilled" ? t24.value : null;
      const premData = prem.status === "fulfilled" ? prem.value : null;
      const liveOk =
        (t24Data?.lastPrice !== undefined && Number(t24Data.lastPrice) > 0) ||
        (premData?.markPrice !== undefined && Number(premData.markPrice) > 0);
      if (!liveOk) {
        if (fast) return fast;
        const cached = this.cachedLiveTickers.get(sym);
        if (cached) return cached;
        return this.snapshotFromSeed(sym, now);
      }
      this.liveAt.set(sym, now);
      this.futuresRestCooldownUntil = 0;

      let st = this.feed.get(sym);
      if (!st) {
        st = { last: 0, mark: 0, index: 0, funding: null, chg: 0, high: 0, low: 0, qvol: 0, futuresAt: 0, restAt: 0 };
        this.feed.set(sym, st);
      }
      if (t24Data?.lastPrice) st.last = Number(t24Data.lastPrice) || st.last;
      if (premData?.markPrice) {
        st.mark = Number(premData.markPrice) || st.last;
        st.futuresAt = now;
      } else if (st.last > 0) {
        st.mark = st.last;
      }
      if (premData?.indexPrice) st.index = Number(premData.indexPrice) || st.index;
      if (premData?.lastFundingRate !== undefined) st.funding = Number(premData.lastFundingRate);
      if (t24Data?.priceChangePercent !== undefined) st.chg = Number(t24Data.priceChangePercent) || st.chg;
      if (t24Data?.highPrice) st.high = Number(t24Data.highPrice) || st.high;
      if (t24Data?.lowPrice) st.low = Number(t24Data.lowPrice) || st.low;
      if (t24Data?.quoteVolume) st.qvol = Number(t24Data.quoteVolume) || st.qvol;
      st.restAt = now;

      const pair = this.pairIndex.get(sym);
      if (pair) {
        if (st.last > 0) pair.price = st.last;
        if (st.mark > 0) pair.markPrice = st.mark;
        if (st.index > 0) pair.indexPrice = st.index;
        pair.chg24h = st.chg;
        if (st.high > 0) pair.high24h = st.high;
        if (st.low > 0) pair.low24h = st.low;
        if (st.qvol > 0) pair.vol24hUsd = st.qvol;
        if (st.funding !== null) pair.fundingRate = st.funding;
        pair.src = "FUTURES";
      }
      const snap = this.snapshotFromFeed(sym, now);
      if (snap) {
        snap.src = "FUTURES";
        snap.live = true;
        this.cachedLiveTickers.set(sym, snap);
        return snap;
      }
      return fast;
    } catch (err) {
      this.noteRestFailure(err);
      if (fast) return fast;
      const cached = this.cachedLiveTickers.get(sym);
      if (cached) return cached;
      return this.snapshotFromSeed(sym, now);
    }
  }

  private snapshotFromSeed(sym: string, now: number): LiveTickerSnapshot | null {
    const pair = this.pairIndex.get(sym);
    if (!pair) return null;
    return {
      symbol: sym,
      lastPrice: pair.price,
      markPrice: pair.markPrice || pair.price,
      indexPrice: pair.indexPrice || pair.price,
      chg24hPct: pair.chg24h,
      high24h: pair.high24h,
      low24h: pair.low24h,
      volume24h: pair.vol24hUsd,
      fundingRate: pair.fundingRate || 0.0001,
      nextFundingTime: pair.nextFundingTime || now + 14400000,
      direction: "FLAT",
      lastUpdated: now,
      src: "FUTURES",
      live: false,
    };
  }

  private noteRestFailure(err: unknown): void {
    const msg = String((err as Error)?.message ?? err);
    if (/-1003\b/.test(msg) || /\b418\b/.test(msg) || /\b429\b/.test(msg) || /\b403\b/.test(msg) || /\b451\b/.test(msg) || /banned/i.test(msg)) {
      this.futuresRestCooldownUntil = Date.now() + FUTURES_REST_COOLDOWN_MS;
      console.warn(`[pricefeed] REST futures dibatasi (${msg.slice(0, 90)}). Cooldown 3 mnt; harga live tetap jalan via WS futures.`);
    }
  }

  public async fetchReal24hTickers(force = false): Promise<BinanceFuturesTickerRaw[]> {
    const now = Date.now();
    // Throttle keras: snapshot full max 1x/60 dtk. Pemanggil (SSE, /api/markets/top,
    // autoSync, scanner) boleh memanggil kapan saja — kelebihan panggilan jadi no-op murah.
    if (!force && now - this.lastSnapshotAttempt < FULL_SNAPSHOT_MIN_MS) {
      return this.cachedTickers;
    }
    if (this.isFetching) {
      return this.cachedTickers;
    }
    // Saat REST di-cooldown (ban/limit): JANGAN pakai pasar lain — sajikan cache futures.
    if (!force && now < this.futuresRestCooldownUntil) {
      return this.cachedTickers;
    }

    this.isFetching = true;
    this.lastSnapshotAttempt = now;
    try {
      const [t24Res, premRes] = await Promise.allSettled([
        this.requestFapi("/fapi/v1/ticker/24hr"),
        this.requestFapi("/fapi/v1/premiumIndex"),
      ]);

      const data = t24Res.status === "fulfilled" && Array.isArray(t24Res.value) ? t24Res.value : [];
      const premList = premRes.status === "fulfilled" && Array.isArray(premRes.value) ? premRes.value : [];

      if (data.length > 0) {
        this.futuresRestCooldownUntil = 0;
        const premMap = new Map<string, BinancePremiumIndexRaw>();
        for (const p of premList) {
          if (p && p.symbol) premMap.set(p.symbol, p);
        }

        const usdtTickers = data.filter(
          (t: BinanceFuturesTickerRaw) =>
            typeof t?.symbol === "string" &&
            // Format keras: basis 2-12 alfanumerik murni + USDT.
            // Menolak simbol aneh/emoji/CJK dari feed (contoh nyata 25 Sep 2026:
            // "龙虾USDT" lolos filter endsWith dan sempat dibuka posisinya oleh bot).
            SYMBOL_RE.test(t.symbol) &&
            // ONLY FUTURES: hanya PERPETUAL terkonfirmasi (fail-open bila allowlist kosong).
            isPerpListed(t.symbol) !== false
        );
        this.cachedTickers = usdtTickers;
        this.lastFetchedAt = Date.now();

        // Categorize pairs
        this.cachedPairs = usdtTickers.map((t) => {
          const sym = t.symbol;
          const base = sym.replace(/USDT$/, "");
          const prem = premMap.get(sym);

          const lastPrice = Number(t.lastPrice) || 0;
          const markPrice = prem?.markPrice ? Number(prem.markPrice) : lastPrice;
          const indexPrice = prem?.indexPrice ? Number(prem.indexPrice) : markPrice;
          const fundingRate = prem?.lastFundingRate ? Number(prem.lastFundingRate) : 0.0001;
          const nextFundingTime = prem?.nextFundingTime ? Number(prem.nextFundingTime) : Date.now() + 14400000;
          const prev = this.feed.get(sym);
          const liveMark = prev && Date.now() - Math.max(prev.futuresAt, prev.restAt) < 10_000 && prev.mark > 0 ? prev.mark : markPrice;

          return {
            symbol: sym,
            baseAsset: base,
            quoteAsset: "USDT",
            price: lastPrice,
            markPrice: liveMark,
            indexPrice,
            chg24h: Number(t.priceChangePercent) || 0,
            vol24hUsd: Number(t.quoteVolume) || 0,
            high24h: Number(t.highPrice) || 0,
            low24h: Number(t.lowPrice) || 0,
            fundingRate,
            nextFundingTime,
            category: categorize(sym),
            src: "FUTURES" as PriceSrc,
          };
        });
        this.rebuildPairIndex();
        // Tandai harga REST ini LIVE + isi feed merged.
        for (const p of this.cachedPairs) {
          this.liveAt.set(p.symbol, this.lastFetchedAt);
          let st = this.feed.get(p.symbol);
          if (!st) {
            st = { last: 0, mark: 0, index: 0, funding: null, chg: 0, high: 0, low: 0, qvol: 0, futuresAt: 0, restAt: 0 };
            this.feed.set(p.symbol, st);
          }
          if (p.price > 0) st.last = p.price;
          if (now - st.futuresAt > 10_000 && p.markPrice > 0) st.mark = p.markPrice;
          st.chg = p.chg24h;
          st.high = p.high24h;
          st.low = p.low24h;
          st.qvol = p.vol24hUsd;
          st.restAt = this.lastFetchedAt;
        }

        // Sync into defaultMarketsService so /api/markets/top serves real data!
        const rawList: RawTicker24h[] = usdtTickers.map((t) => {
          const chg = Number(t.priceChangePercent) || 0;
          return {
            symbol: t.symbol,
            lastPrice: Number(t.lastPrice) || 0,
            priceChangePercent: chg,
            quoteVolume: Number(t.quoteVolume) || 0,
            regime: Math.abs(chg) > 8 ? "VOLATILE" : Math.abs(chg) > 2 ? "TRENDING" : "RANGING",
            eligible: (Number(t.quoteVolume) || 0) > env.VOLUME_MIN_USD,
            eligibleReason: (Number(t.quoteVolume) || 0) <= env.VOLUME_MIN_USD ? "VOLUME_BELOW_MIN" : null,
          };
        });

        defaultMarketsService.setTickers(rawList, this.lastFetchedAt);

        // Notify real-time streaming listeners
        for (const listener of this.tickerListeners) {
          try {
            listener(this.cachedPairs);
          } catch {}
        }
      } else {
        console.warn("[pricefeed] snapshot futures kosong/gagal — sajikan cache terakhir (TANPA fallback pasar lain).");
      }
    } catch (err) {
      this.noteRestFailure(err);
    } finally {
      this.isFetching = false;
    }

    return this.cachedTickers;
  }

  // True bila harga simbol berasal dari feed FUTURES live (WS/REST sukses) dalam maxAgeMs terakhir.
  // Dipakai sebagai gate entry: harga basi/seed TIDAK BOLEH jadi dasar order.
  public isPriceLive(symbol: string, maxAgeMs = 120_000): boolean {
    const sym = symbol.toUpperCase();
    const at = this.liveAt.get(sym);
    if (at !== undefined && Date.now() - at <= maxAgeMs) return true;
    const st = this.feed.get(sym);
    if (st && Date.now() - Math.max(st.futuresAt, st.restAt) <= maxAgeMs && (st.mark > 0 || st.last > 0)) {
      this.liveAt.set(sym, Date.now());
      return true;
    }
    const p = this.cachedPairs.find((cp) => cp.symbol === sym);
    if (p && (p.markPrice > 0 || p.price > 0) && Date.now() - this.lastFetchedAt <= maxAgeMs) {
      this.liveAt.set(sym, Date.now());
      return true;
    }
    return false;
  }

  // Hub harga futures untuk markets & terminal: 100% dari feed futures (0 REST,
  // 0 koneksi WS di frontend) — tahan di jaringan yang memblokir WebSocket.
  // Frontend (markets + terminal) baca dari hub via /api/prices/*.
  public startPriceHub(_intervalMs = 2000): void {
    // Kompatibilitas: hub kini didorong WS futures — cukup pastikan feed menyala.
    // Parameter interval diabaikan (tidak ada lagi polling REST per 2 dtk yang memicu ban).
    this.startLiveFeeds();
  }

  public getHubPrices(symbols?: string[]): { map: Record<string, { p: number; m: number; t: number; s: PriceSrc; c: number; v: number; h: number; l: number; r: number | null }>; ageMs: number } {
    const out: Record<string, { p: number; m: number; t: number; s: PriceSrc; c: number; v: number; h: number; l: number; r: number | null }> = {};
    const pick = (sym: string) => {
      const st = this.feed.get(sym);
      if (!st) return;
      const m = st.mark > 0 ? st.mark : st.last;
      const p = st.last > 0 ? st.last : m;
      if (!(m > 0)) return;
      const t = Math.max(st.futuresAt, st.restAt);
      // c = chg24h (%), v = quote volume 24h (USD), h/l = high/low 24h.
      // 23 Okt 2026: field ini ditambahkan supaya browser bisa menampilkan
      // angka DETAIL (volume 24h futures, %24h) untuk SETIAP pair tanpa
      // fetch per-simbol. Sebelumnya hub hanya mengirim p/m sehingga UI
      // mengarang volume/chg dari harga atau menampilkan 0.
      //
      // 23 Okt 2026 (Tahap 8 — Bloomberg-style): r = funding rate per 8 jam.
      // Sumber: WS !markPrice@arr (field "r") via applyFuturesMark. Tanpa ini
      // UI tidak bisa menampilkan TOP FUNDING tanpa N request REST per simbol.
      const r = Number.isFinite(st.funding) ? st.funding : null;
      out[sym] = { p, m, t, s: "FUTURES", c: st.chg, v: st.qvol, h: st.high, l: st.low, r };
    };
    if (!symbols || symbols.length === 0) {
      this.feed.forEach((_v, k) => pick(k));
    } else {
      for (const s of symbols) pick(s.toUpperCase());
    }
    const freshest = Object.values(out).reduce((a, v) => Math.max(a, v.t), 0);
    return { map: out, ageMs: freshest > 0 ? Date.now() - freshest : -1 };
  }

  /** Perubahan 24h (%) per simbol dari cache feed — tanpa panggilan REST baru. */
  public getHubChg24(symbols?: string[]): Record<string, number | null> {
    const out: Record<string, number | null> = {};
    const pick = (sym: string) => {
      const st = this.feed.get(sym);
      out[sym] = st && st.last > 0 && Number.isFinite(st.chg) ? st.chg : null;
    };
    if (!symbols || symbols.length === 0) this.feed.forEach((_v, k) => pick(k));
    else for (const s of symbols) pick(s.toUpperCase());
    return out;
  }

  public isHubLive(maxAgeMs = 8000): boolean {
    return this.futuresWsLiveAt > 0 && Date.now() - this.futuresWsLiveAt <= maxAgeMs;
  }

  public getCachedPairs(): BinancePairMeta[] {
    return this.cachedPairs;
  }

  public getLastSyncTime(): number {
    return this.lastFetchedAt;
  }
}

export const binanceFuturesClient = new BinanceFuturesClient();
