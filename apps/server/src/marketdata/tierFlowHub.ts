// apps/server/src/marketdata/tierFlowHub.ts
// MODUL 5 — TIER & FLOW: size-tier imbalance, per-exchange cumulative delta,
// dan deteksi divergensi antar-bursa.
//
//  - 5 size tier (MEGA/WHALE/LARGE/MEDIUM/SMALL) dengan net delta & buy share.
//  - Seri delta kumulatif per exchange (8 exchange: BINANCE, BYBIT, OKX, GATE,
//    KUCOIN, COINBASE, BITGET, HYPERLIQUID) — spot+perp digabung per exchange.
//  - Divergence alert: dua exchange dengan arah berlawanan dan selisih
//    spread >= $50.000, dihitung tiap 5 menit.
//
// Semua angka berasal dari trade live multi-venue.

import { logger } from "../core/logger.js";
import { multiVenueOrderFlowHub } from "./multiVenueOrderFlowHub.js";
import { EXCHANGE_ORDER, EXCHANGE_COLOR, type DivergenceAlert, type TierImbalanceRow } from "./microstructureTypes.js";

/** Ambang minimal selisih net delta untuk memicu alert divergensi. */
export const DIVERGENCE_MIN_SPREAD_USD = 50_000;
/** Interval rekomputasi alert (ms). */
const ALERT_INTERVAL_MS = 5 * 60_000;
/** Jumlah alert yang disimpan. */
const MAX_ALERTS = 100;

class TierFlowHub {
  private started = false;
  private startedAt = Date.now();
  private timer: NodeJS.Timeout | null = null;
  private alerts: DivergenceAlert[] = [];
  private lastAlertScan = 0;
  private perExchangeToggles = new Set<string>(EXCHANGE_ORDER);

  start(): void {
    if (this.started) return;
    this.started = true;
    this.startedAt = Date.now();
    this.timer = setInterval(() => this.scanDivergences(), ALERT_INTERVAL_MS);
    logger.info("TIER_FLOW_HUB_STARTED");
  }

  stop(): void {
    this.started = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  get startedAtMs(): number { return this.startedAt; }

  /** Tier imbalance untuk simbol & range (detik). */
  tiers(symbol: string, rangeSec: number): TierImbalanceRow[] {
    return multiVenueOrderFlowHub.tierImbalance(symbol, rangeSec).rows;
  }

  /** Seri delta kumulatif per exchange. */
  perExchangeSeries(symbol: string, rangeSec: number): {
    exchange: string; color: string; total: number; points: { t: number; v: number }[];
  }[] {
    const raw = multiVenueOrderFlowHub.perExchangeSeries(symbol, rangeSec);
    // Urutkan sesuai EXCHANGE_ORDER agar warna & urutan stabil.
    const byName = new Map(raw.map((r) => [r.exchange, r]));
    const out: { exchange: string; color: string; total: number; points: { t: number; v: number }[] }[] = [];
    for (const ex of EXCHANGE_ORDER) {
      const r = byName.get(ex);
      if (!r) continue;
      out.push({ exchange: ex, color: EXCHANGE_COLOR[ex] ?? "#8a8f98", total: r.total, points: r.points });
    }
    // Exchange lain yang tidak ada di daftar (mis. venue baru) tetap ditampilkan.
    for (const r of raw) {
      if (EXCHANGE_ORDER.includes(r.exchange)) continue;
      out.push({ exchange: r.exchange, color: EXCHANGE_COLOR[r.exchange] ?? "#8a8f98", total: r.total, points: r.points });
    }
    return out;
  }

  /** Net delta per exchange (ringkas). */
  perExchangeDelta(symbol: string, rangeSec: number): { exchange: string; delta: number; buyUsd: number; sellUsd: number }[] {
    return multiVenueOrderFlowHub.perExchangeDelta(symbol, rangeSec);
  }

  /**
   * Deteksi divergensi: cari pasangan exchange dengan arah berlawanan dan
   * selisih net delta >= ambang. Ambang mengikuti skala (dinyalakan hanya bila
   * ada yang beda arah).
   */
  scanDivergences(symbol = "BTC"): DivergenceAlert[] {
    const rows = multiVenueOrderFlowHub.perExchangeDelta(symbol, 5 * 60);
    const buyers = rows.filter((r) => r.delta > 0).sort((a, b) => b.delta - a.delta);
    const sellers = rows.filter((r) => r.delta < 0).sort((a, b) => a.delta - b.delta);
    const found: DivergenceAlert[] = [];
    for (const b of buyers) {
      for (const s of sellers) {
        const spread = b.delta - s.delta; // b.delta > 0, s.delta < 0 -> selalu positif
        if (spread < DIVERGENCE_MIN_SPREAD_USD) continue;
        found.push({
          t: Date.now(),
          buyerExchange: b.exchange,
          buyerDelta: b.delta,
          sellerExchange: s.exchange,
          sellerDelta: s.delta,
          spreadUsd: spread,
        });
      }
    }
    found.sort((a, b) => b.spreadUsd - a.spreadUsd);
    const top = found.slice(0, 10);
    this.alerts = [...top, ...this.alerts].slice(0, MAX_ALERTS);
    this.lastAlertScan = Date.now();
    return top;
  }

  /** Alert yang tersimpan (terbaru dulu). */
  recentAlerts(limit = 25): DivergenceAlert[] {
    return this.alerts.slice(0, limit);
  }

  get alertsScannedAt(): number { return this.lastAlertScan; }

  /**
   * Bias whale vs ritel: apakah flow besar (>= $100K) satu arah sementara
   * flow kecil berlawanan arah.
   */
  whaleRetailBias(symbol: string, rangeSec: number): {
    bias: string; whaleDelta: number; retailDelta: number; note: string;
  } {
    const rows = this.tiers(symbol, rangeSec);
    const byTier = new Map(rows.map((r) => [r.tier, r]));
    const mega = byTier.get("MEGA");
    const whale = byTier.get("WHALE");
    const large = byTier.get("LARGE");
    const medium = byTier.get("MEDIUM");
    const small = byTier.get("SMALL");
    const whaleDelta = (mega?.netDeltaUsd ?? 0) + (whale?.netDeltaUsd ?? 0) + (large?.netDeltaUsd ?? 0);
    const retailDelta = (medium?.netDeltaUsd ?? 0) + (small?.netDeltaUsd ?? 0);
    let bias = "NEUTRAL";
    let note = "Aliran besar dan ritel searah";
    if (whaleDelta > 0 && retailDelta < 0) { bias = "WHALE_ACCUMULATING"; note = "Whale beli, ritel jual (aksumulasi tersembunyi)"; }
    else if (whaleDelta < 0 && retailDelta > 0) { bias = "WHALE_DISTRIBUTING"; note = "Whale jual, ritel beli (distribusi tersembunyi)"; }
    else if (whaleDelta > 0 && retailDelta > 0) { bias = "ALIGNED_BULLISH"; note = "Whale & ritel sama-sama beli"; }
    else if (whaleDelta < 0 && retailDelta < 0) { bias = "ALIGNED_BEARISH"; note = "Whale & ritel sama-sama jual"; }
    else if (whaleDelta === 0 && retailDelta === 0) { bias = "UNKNOWN"; note = "Belum ada aliran pada window ini"; }
    return { bias, whaleDelta, retailDelta, note };
  }
}

export const tierFlowHub = new TierFlowHub();
