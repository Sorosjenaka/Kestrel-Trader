// apps/server/src/markets/marketsService.ts - Top 20 Gainer & Loser 24j + Scanner View (FR-30, NFR-06, US-09).
import { checkAssetClass } from "../universe/assetClassGuard.js";
import { env } from "../core/env.js";

export type MarketRegime = "TRENDING" | "RANGING" | "VOLATILE" | "UNCERTAIN";

export interface TopMover {
  symbol: string;
  price: number;
  chg24hPct: number;
  volume24hUsd: number;
  regime: MarketRegime;
  eligible: boolean;
  eligibleReason: string | null;
}

export interface TopMoversResult {
  gainers: TopMover[];
  losers: TopMover[];
  refreshedAt: number;
  totalUniverse: number;
  filteredUniverse: number;
  all: boolean;
  limit: number;
}

export interface RawTicker24h {
  symbol: string;
  lastPrice: number;
  priceChangePercent: number;
  quoteVolume: number;
  regime?: MarketRegime;
  eligible?: boolean;
  eligibleReason?: string | null;
}

export const DEFAULT_MIN_VOLUME_USD = env.VOLUME_MIN_USD;

export class MarketsService {
  private tickers: Map<string, TopMover> = new Map();
  private lastRefreshedAt: number = 0;
  private readonly defaultMinVolume: number;

  constructor(options?: { minVolumeUsd?: number; initialTickers?: RawTicker24h[] }) {
    this.defaultMinVolume = options?.minVolumeUsd ?? DEFAULT_MIN_VOLUME_USD;
    if (options?.initialTickers && options.initialTickers.length > 0) {
      this.setTickers(options.initialTickers);
    } else {
      this.seedDefaultUniverse();
    }
  }

  setTickers(rawList: RawTicker24h[], timestamp = Date.now()): void {
    this.tickers.clear();
    for (const raw of rawList) {
      const sym = raw.symbol.toUpperCase();
      // CRYPTO-ONLY: Komoditas/Saham/ETF/Indeks/FX disaring keluar
      if (checkAssetClass(sym).blocked) continue;

      const isEligibleVol = raw.quoteVolume > this.defaultMinVolume;
      const eligible = raw.eligible !== undefined ? raw.eligible : isEligibleVol;
      const eligibleReason =
        raw.eligibleReason !== undefined
          ? raw.eligibleReason
          : !isEligibleVol
          ? "VOLUME_BELOW_MIN"
          : null;

      const mover: TopMover = {
        symbol: raw.symbol.toUpperCase(),
        price: Number(raw.lastPrice) || 0,
        chg24hPct: Number(raw.priceChangePercent) || 0,
        volume24hUsd: Number(raw.quoteVolume) || 0,
        regime: raw.regime ?? (Math.abs(raw.priceChangePercent) > 6 ? "TRENDING" : "RANGING"),
        eligible,
        eligibleReason,
      };
      this.tickers.set(mover.symbol, mover);
    }
    this.lastRefreshedAt = timestamp;
  }

  getTopMovers(options?: {
    limit?: number;
    all?: boolean;
    minVolumeUsd?: number;
  }): TopMoversResult {
    const limit = Math.max(1, Math.min(100, options?.limit ?? 20));
    const showAll = options?.all === true;
    const minVol = options?.minVolumeUsd ?? this.defaultMinVolume;

    const allItems = Array.from(this.tickers.values());
    const totalUniverse = allItems.length;

    const pool = showAll ? allItems : allItems.filter((item) => item.volume24hUsd > minVol);

    const gainers = [...pool]
      .sort((a, b) => b.chg24hPct - a.chg24hPct)
      .slice(0, limit);

    const losers = [...pool]
      .sort((a, b) => a.chg24hPct - b.chg24hPct)
      .slice(0, limit);

    return {
      gainers,
      losers,
      refreshedAt: this.lastRefreshedAt,
      totalUniverse,
      filteredUniverse: pool.length,
      all: showAll,
      limit,
    };
  }

  getTicker(symbol: string): TopMover | undefined {
    return this.tickers.get(symbol.toUpperCase());
  }

  getLastRefreshedAt(): number {
    return this.lastRefreshedAt;
  }

  isFresh(maxAgeMs = 60_000, now = Date.now()): boolean {
    return now - this.lastRefreshedAt <= maxAgeMs;
  }

  private seedDefaultUniverse(): void {
    const seeds = [
      { s: "BTCUSDT", p: 65420.5, chg: 3.8, volM: 1250, reg: "TRENDING" as const },
      { s: "ETHUSDT", p: 3450.2, chg: 5.2, volM: 680, reg: "TRENDING" as const },
      { s: "SOLUSDT", p: 152.4, chg: 14.6, volM: 420, reg: "TRENDING" as const },
      { s: "PEPEUSDT", p: 0.0000084, chg: 22.4, volM: 210, reg: "VOLATILE" as const },
      { s: "DOGEUSDT", p: 0.124, chg: 11.2, volM: 180, reg: "TRENDING" as const },
      { s: "BNBUSDT", p: 585.1, chg: 2.1, volM: 160, reg: "RANGING" as const },
      { s: "NEARUSDT", p: 5.42, chg: 9.8, volM: 95, reg: "TRENDING" as const },
      { s: "AVAXUSDT", p: 28.6, chg: 7.4, volM: 88, reg: "TRENDING" as const },
      { s: "SUIUSDT", p: 1.84, chg: 18.2, volM: 140, reg: "VOLATILE" as const },
      { s: "APTUSDT", p: 8.92, chg: 12.1, volM: 75, reg: "TRENDING" as const },
      { s: "WIFUSDT", p: 2.45, chg: 16.5, volM: 110, reg: "VOLATILE" as const },
      { s: "FETUSDT", p: 1.48, chg: 15.3, volM: 65, reg: "TRENDING" as const },
      { s: "RENDERUSDT", p: 6.25, chg: 13.9, volM: 58, reg: "TRENDING" as const },
      { s: "TAOUSDT", p: 480.0, chg: 19.8, volM: 92, reg: "VOLATILE" as const },
      { s: "INJUSDT", p: 21.4, chg: 8.7, volM: 45, reg: "TRENDING" as const },
      { s: "RUNEUSDT", p: 4.82, chg: 7.9, volM: 38, reg: "TRENDING" as const },
      { s: "LINKUSDT", p: 12.1, chg: 4.5, volM: 52, reg: "RANGING" as const },
      { s: "XRPUSDT", p: 0.582, chg: 3.1, volM: 85, reg: "RANGING" as const },
      { s: "MATICUSDT", p: 0.412, chg: 6.2, volM: 32, reg: "TRENDING" as const },
      { s: "ADAUSDT", p: 0.365, chg: 4.1, volM: 41, reg: "RANGING" as const },
      { s: "DOTUSDT", p: 4.62, chg: 5.5, volM: 29, reg: "TRENDING" as const },
      { s: "ARBUSDT", p: 0.59, chg: 6.8, volM: 35, reg: "TRENDING" as const },
      { s: "OPUSDT", p: 1.62, chg: 8.1, volM: 31, reg: "TRENDING" as const },
      { s: "LDOUSDT", p: 1.25, chg: 7.1, volM: 22, reg: "TRENDING" as const },
      { s: "AAVEUSDT", p: 142.5, chg: 10.4, volM: 62, reg: "TRENDING" as const },
      { s: "TRUMPUSDT", p: 14.2, chg: -16.8, volM: 54, reg: "VOLATILE" as const },
      { s: "HMSTRUSDT", p: 0.0054, chg: -14.2, volM: 42, reg: "VOLATILE" as const },
      { s: "CATIUSDT", p: 0.52, chg: -12.5, volM: 33, reg: "VOLATILE" as const },
      { s: "NOTUSDT", p: 0.0078, chg: -11.4, volM: 48, reg: "VOLATILE" as const },
      { s: "DOGSUSDT", p: 0.00082, chg: -10.1, volM: 28, reg: "VOLATILE" as const },
      { s: "SEIUSDT", p: 0.42, chg: -9.5, volM: 36, reg: "TRENDING" as const },
      { s: "TIAUSDT", p: 5.85, chg: -8.7, volM: 44, reg: "TRENDING" as const },
      { s: "STXUSDT", p: 1.82, chg: -8.1, volM: 27, reg: "TRENDING" as const },
      { s: "KASUSDT", p: 0.142, chg: -7.6, volM: 21, reg: "RANGING" as const },
      { s: "FLOKIUSDT", p: 0.000145, chg: -7.2, volM: 39, reg: "VOLATILE" as const },
      { s: "BONKUSDT", p: 0.000021, chg: -6.8, volM: 45, reg: "VOLATILE" as const },
      { s: "FTMUSDT", p: 0.65, chg: -6.2, volM: 24, reg: "RANGING" as const },
      { s: "GALAUSDT", p: 0.022, chg: -5.9, volM: 19, reg: "RANGING" as const },
      { s: "SANDUSDT", p: 0.28, chg: -5.4, volM: 17, reg: "RANGING" as const },
      { s: "MANAUSDT", p: 0.31, chg: -5.1, volM: 16, reg: "RANGING" as const },
      { s: "CHZUSDT", p: 0.068, chg: -4.8, volM: 18, reg: "RANGING" as const },
      { s: "AXSUSDT", p: 4.85, chg: -4.5, volM: 15.5, reg: "RANGING" as const },
      { s: "DYDXUSDT", p: 1.05, chg: -4.2, volM: 16.2, reg: "RANGING" as const },
      { s: "CRVUSDT", p: 0.31, chg: -3.8, volM: 20.5, reg: "RANGING" as const },
      { s: "MKRUSDT", p: 1620.0, chg: -3.5, volM: 25.0, reg: "RANGING" as const },
      { s: "SNXUSDT", p: 1.62, chg: -3.2, volM: 15.8, reg: "RANGING" as const },
      { s: "LOWVOL1USDT", p: 0.15, chg: 35.0, volM: 4.5, reg: "VOLATILE" as const, el: false, r: "VOLUME_BELOW_MIN" },
      { s: "LOWVOL2USDT", p: 1.20, chg: 28.0, volM: 8.2, reg: "TRENDING" as const },
      { s: "LOWVOL3USDT", p: 0.05, chg: -25.0, volM: 3.1, reg: "VOLATILE" as const, el: false, r: "VOLUME_BELOW_MIN" },
      { s: "LOWVOL4USDT", p: 2.50, chg: -22.0, volM: 6.8, reg: "VOLATILE" as const, el: false, r: "VOLUME_BELOW_MIN" },
      { s: "BADCOINUSDT", p: 0.01, chg: 50.0, volM: 25.0, reg: "UNCERTAIN" as const, el: false, r: "BLACKLISTED" },
    ];

    const rawList: RawTicker24h[] = seeds.map((s) => ({
      symbol: s.s,
      lastPrice: s.p,
      priceChangePercent: s.chg,
      quoteVolume: s.volM * 1_000_000,
      regime: s.reg,
      eligible: "el" in s ? s.el : undefined,
      eligibleReason: "r" in s ? s.r : undefined,
    }));

    this.setTickers(rawList, Date.now());
  }
}

export const defaultMarketsService = new MarketsService();
