// apps/server/src/marketdata/volumeProfileHub.ts
// MODUL 4 (a/b) — LARGE TRADES FEED & VOLUME PROFILE.
//
// Large Trades Feed: transaksi >= $10K dari SELURUH venue, berjenjang:
//   MEGA >= $1M · WHALE >= $500K · LARGE >= $100K · MEDIUM >= $50K · SMALL >= $10K.
//
// Volume Profile: histogram buy/sell per tingkat harga (binned), dengan POC
// (Point of Control), VAH & VAL (70% Value Area) dan posisi harga terhadap
// value area.
//
// GRID harga GEOMETRIS (log-spaced) supaya bin tetap stabil saat harga
// bergerak (isi bin tidak "menggeser"). Dua tingkat resolusi:
//
//   FINE  (0,005% per bin) -> dipakai untuk range 1h & 1d. Cukup rapat
//          supaya profil 1 jam bisa ditampilkan sebagai 35-40 bin
//          (spesifikasi operator).
//   COARSE(0,02%  per bin) -> akumulasi kumulatif sejak start, untuk range 7d
//          (hemat RAM: 7 hari x 16 simbol x resolusi rapat tidak muat).
//
// Bin tampilan SELALU dipatok ke 35-40 (lihat DISPLAY_BINS): rentang harga
// yang terisi dibagi rata menjadi N bin tampilan, lalu volume tiap indeks
// fine dipetakan ke bin tampilan. Bin yang kosong = memang tidak ada
// transaksi di harga itu (dib truthfully, bukan diisi interpolasi).
//
// Data disimpan per menit (sparse) supaya range 1h/1d bisa disusun ulang
// tanpa menyimpan tape tak terbatas. Range 7d memakai akumulasi kumulatif
// dan ditandai `partialWindow` bila uptime belum 7 hari.
//
// TIDAK ADA data sintetis: semua bin berasal dari trade live.

import { logger } from "../core/logger.js";
import { multiVenueOrderFlowHub } from "./multiVenueOrderFlowHub.js";
import type { TapeTrade, VolumeProfileBin, VolumeProfileSnapshot } from "./microstructureTypes.js";

/** Langkah indeks harga FINE (relatif): 0,005% per bin. */
const GRID_B_FINE = 0.00005;
/** Langkah indeks harga COARSE (relatif): 0,02% per bin. */
const GRID_B_COARSE = 0.0002;
/** Batas indeks dari anchor. */
const GRID_LIMIT = 50_000;
/** Jumlah menit granular yang disimpan (2 hari). */
const MINUTE_RETENTION = 2880;
/** Target bin tampil (spesifikasi: 35-40). */
const DISPLAY_BINS = 38;
/** Value area = 70% volume di sekitar POC. */
const VALUE_AREA_PCT = 0.70;

/** Batas bawah tier feed large trades (USD). */
export const TIER_FLOORS: { tier: string; floor: number }[] = [
  { tier: "MEGA", floor: 1_000_000 },
  { tier: "WHALE", floor: 500_000 },
  { tier: "LARGE", floor: 100_000 },
  { tier: "MEDIUM", floor: 50_000 },
  { tier: "SMALL", floor: 10_000 },
];

/** Bin sparse per menit: array datar [idx, buy, sell, idx, buy, sell, ...]. */
type MinuteGrid = Float64Array;

interface SymbolProfile {
  symbol: string;
  anchorPrice: number;
  /** Akumulasi kumulatif COARSE sejak proses start (Map<idx, {buy,sell}>). */
  cum: Map<number, { buy: number; sell: number }>;
  /** Grid FINE per menit: minute epoch -> Float64Array triples. */
  minutes: Map<number, MinuteGrid>;
  lastPrice: number | null;
  lastTradeAt: number;
  /** TAHAP 6B: waktu trade terakhir DITERIMA proses (bukan waktu event bursa). */
  lastTradeReceivedAt: number | null;
}

class VolumeProfileHub {
  private profiles = new Map<string, SymbolProfile>();
  private started = false;
  private startedAt = Date.now();
  private unsub: (() => void) | null = null;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.startedAt = Date.now();
    this.unsub = multiVenueOrderFlowHub.onTrade((t) => this.onTrade(t));
    logger.info("VOLUME_PROFILE_HUB_STARTED");
  }

  stop(): void {
    this.started = false;
    this.unsub?.();
    this.unsub = null;
  }

  get startedAtMs(): number { return this.startedAt; }

  /**
   * TAHAP 6B: waktu evidence sumber untuk panel large trades + volume profile —
   * epoch ms trade terakhir yang masuk ke profil (bukan waktu snapshot dibuat).
   * null = belum ada trade untuk simbol ini (UNKNOWN, bukan "sekarang").
   */
  lastTradeAtMs(symbol: string): number | null {
    const p = this.profiles.get(symbol.toUpperCase());
    return p?.lastTradeAt ?? null;
  }

  /**
   * TAHAP 6B: waktu data trade DITERIMA proses (epoch ms) — terpisah dari
   * waktu event bursa. null = UNKNOWN.
   */
  lastTradeReceivedAtMs(symbol: string): number | null {
    const p = this.profiles.get(symbol.toUpperCase());
    return p?.lastTradeReceivedAt ?? null;
  }

  private onTrade(t: TapeTrade): void {
    let p = this.profiles.get(t.symbol);
    if (!p) {
      p = {
        symbol: t.symbol,
        anchorPrice: t.price,
        cum: new Map(),
        minutes: new Map(),
        lastPrice: t.price,
        lastTradeAt: t.t,
        lastTradeReceivedAt: Date.now(),
      };
      this.profiles.set(t.symbol, p);
    }
    p.lastPrice = t.price;
    p.lastTradeAt = t.t;
    p.lastTradeReceivedAt = Date.now();

    // Indeks FINE (untuk 1h/1d) & indeks COARSE (untuk 7d).
    const fineIdx = this.indexOf(t.price, p.anchorPrice, GRID_B_FINE);
    const coarseIdx = this.indexOf(t.price, p.anchorPrice, GRID_B_COARSE);
    if (fineIdx === null && coarseIdx === null) return;

    // Kumulatif COARSE.
    if (coarseIdx !== null) {
      const cur = p.cum.get(coarseIdx) ?? { buy: 0, sell: 0 };
      if (t.takerSide === "BUY") cur.buy += t.usd; else cur.sell += t.usd;
      p.cum.set(coarseIdx, cur);
    }

    // Grid FINE per menit (sparse, array datar).
    if (fineIdx !== null) {
      const minute = Math.floor(t.t / 60000);
      const grid = p.minutes.get(minute) ?? new Float64Array(0);
      p.minutes.set(minute, this.addTriple(grid, fineIdx, t.takerSide === "BUY" ? t.usd : 0, t.takerSide === "SELL" ? t.usd : 0));

      // Retensi.
      if (p.minutes.size > MINUTE_RETENTION + 60) {
        const cutoff = minute - MINUTE_RETENTION;
        for (const k of p.minutes.keys()) if (k < cutoff) p.minutes.delete(k);
      }
    }
  }

  /** Tambah (idx,buy,sell) ke array triple (dimutasi in-place, grown by copy). */
  private addTriple(grid: MinuteGrid, idx: number, buy: number, sell: number): MinuteGrid {
    const n = grid.length;
    for (let i = 0; i < n; i += 3) {
      if (grid[i] === idx) {
        grid[i + 1]! += buy;
        grid[i + 2]! += sell;
        return grid;
      }
    }
    const next = new Float64Array(n + 3);
    next.set(grid);
    next[n] = idx; next[n + 1] = buy; next[n + 2] = sell;
    return next;
  }

  private indexOf(price: number, anchor: number, b: number): number | null {
    if (!(price > 0) || !(anchor > 0)) return null;
    const idx = Math.round(Math.log(price / anchor) / Math.log(1 + b));
    if (!Number.isFinite(idx) || Math.abs(idx) > GRID_LIMIT) return null;
    return idx;
  }

  private priceOf(idx: number, anchor: number, b: number): number {
    return anchor * Math.pow(1 + b, idx);
  }

  /** Susun profil untuk simbol & range. */
  build(symbol: string, range: "1h" | "1d" | "7d"): VolumeProfileSnapshot {
    const sym = symbol.toUpperCase();
    const p = this.profiles.get(sym);
    const now = Date.now();
    const uptimeMs = now - this.startedAt;
    const rangeMs = range === "1h" ? 3600_000 : range === "1d" ? 86_400_000 : 7 * 86_400_000;

    const empty = (): VolumeProfileSnapshot => ({
      symbol: sym, range, bins: [], pocPrice: null, pocVolumeUsd: 0, pocBuySharePct: null,
      vahPrice: null, valPrice: null, priceVsValueArea: "UNKNOWN", price: p?.lastPrice ?? null,
      totalUsd: 0, updatedAt: now, partialWindow: true,
    });
    if (!p) return empty();

    // Sumber data per range:
    //   1h / 1d -> grid FINE per menit (resolusi rapat).
    //   7d      -> akumulasi COARSE sejak start.
    let acc: Map<number, { buy: number; sell: number }>;
    let step: number;   // langkah indeks sumber
    let partialWindow: boolean;
    if (range === "7d") {
      acc = p.cum;
      step = GRID_B_COARSE;
      partialWindow = uptimeMs < rangeMs;
    } else {
      acc = new Map();
      step = GRID_B_FINE;
      const fromMinute = Math.floor((now - rangeMs) / 60000);
      for (const [minute, grid] of p.minutes) {
        if (minute < fromMinute) continue;
        for (let i = 0; i < grid.length; i += 3) {
          const idx = grid[i]!;
          const cur = acc.get(idx) ?? { buy: 0, sell: 0 };
          cur.buy += grid[i + 1]!;
          cur.sell += grid[i + 2]!;
          acc.set(idx, cur);
        }
      }
      partialWindow = uptimeMs < rangeMs;
    }

    const idxs = [...acc.keys()].sort((a, b) => a - b);
    if (idxs.length === 0) return empty();

    // ── Bin tampilan: 35-40 bin di atas rentang harga yang terisi ──────────
    // Peta indeks sumber -> bin tampilan. `perBin` boleh pecahan supaya
    // jumlah bin tampilan selalu mendekati DISPLAY_BINS walau rentang harga
    // terisi hanya sedikit indeks.
    const loIdx = idxs[0]!;
    const hiIdx = idxs[idxs.length - 1]!;
    const span = hiIdx - loIdx + 1;
    const nBins = Math.min(DISPLAY_BINS, Math.max(1, span));
    const perBin = span / nBins;

    const merged = new Map<number, { buy: number; sell: number }>();
    for (const idx of idxs) {
      const b = Math.min(nBins - 1, Math.max(0, Math.floor((idx - loIdx) / perBin)));
      const v = acc.get(idx)!;
      const cur = merged.get(b) ?? { buy: 0, sell: 0 };
      cur.buy += v.buy; cur.sell += v.sell;
      merged.set(b, cur);
    }

    const bins: VolumeProfileBin[] = [];
    let totalUsd = 0;
    for (let b = 0; b < nBins; b++) {
      const v = merged.get(b);
      const centerIdx = loIdx + (b + 0.5) * perBin;
      const price = this.priceOf(centerIdx, p.anchorPrice, step);
      const buy = v?.buy ?? 0;
      const sell = v?.sell ?? 0;
      const total = buy + sell;
      totalUsd += total;
      bins.push({ price, buyUsd: buy, sellUsd: sell, totalUsd: total });
    }

    // POC.
    let pocIdx = 0;
    for (let i = 1; i < bins.length; i++) {
      if (bins[i]!.totalUsd > bins[pocIdx]!.totalUsd) pocIdx = i;
    }
    const poc = bins[pocIdx]!;
    const pocTotal = poc.totalUsd;

    // Value area: perluas dari POC ke atas & bawah sampai 70% volume.
    const target = totalUsd * VALUE_AREA_PCT;
    let up = pocIdx, down = pocIdx;
    let acc2 = pocTotal;
    while (acc2 < target && (up + 1 < bins.length || down - 1 >= 0)) {
      const upVol = up + 1 < bins.length ? bins[up + 1]!.totalUsd : -1;
      const downVol = down - 1 >= 0 ? bins[down - 1]!.totalUsd : -1;
      if (upVol < 0 && downVol < 0) break;
      if (upVol >= downVol) { up += 1; acc2 += upVol; } else { down -= 1; acc2 += downVol; }
    }
    const vah = bins[up]!.price;
    const val = bins[down]!.price;

    const price = p.lastPrice;
    let priceVsValueArea: VolumeProfileSnapshot["priceVsValueArea"] = "UNKNOWN";
    if (price != null) {
      if (price > vah) priceVsValueArea = "ABOVE_VAH";
      else if (price < val) priceVsValueArea = "BELOW_VAL";
      else priceVsValueArea = "INSIDE_VA";
    }

    return {
      symbol: sym,
      range,
      bins,
      pocPrice: poc.price,
      pocVolumeUsd: pocTotal,
      pocBuySharePct: pocTotal > 0 ? (poc.buyUsd / pocTotal) * 100 : null,
      vahPrice: vah,
      valPrice: val,
      priceVsValueArea,
      price,
      totalUsd,
      updatedAt: now,
      partialWindow,
    };
  }

  /** Tape trade besar lintas venue (Panel 4 feed). */
  largeTrades(symbol: string | null, minUsd: number, limit: number): TapeTrade[] {
    return multiVenueOrderFlowHub.getTape(symbol, minUsd, limit);
  }

  /** Tier breakdown dari tape besar (untuk filter UI). */
  tierCounts(symbol: string | null, minUsd: number): Record<string, number> {
    const out: Record<string, number> = { MEGA: 0, WHALE: 0, LARGE: 0, MEDIUM: 0, SMALL: 0 };
    for (const t of multiVenueOrderFlowHub.getTape(symbol, minUsd, 5000)) {
      if (t.largeTier) out[t.largeTier] = (out[t.largeTier] ?? 0) + 1;
    }
    return out;
  }
}

export const volumeProfileHub = new VolumeProfileHub();
