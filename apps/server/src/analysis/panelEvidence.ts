// apps/server/src/analysis/panelEvidence.ts — 26 Okt 2026 (TAHAP 6B)
// Kumpulan bukti mikrostruktur untuk lima panel + ringkasan terstruktur.
//
// Prinsip TAHAP 6B:
//  - "Waktu evidence" = waktu DATA SUMBER (trade terakhir, book terakhir,
//    fetch likuidasi terakhir), BUKAN waktu snapshot dibuat (generatedAt).
//  - Setiap panel menghasilkan brief ringkas: angka penting, sumber, waktu,
//    pendukung, konflik, dan data hilang. Tidak ada narasi panjang.
//  - Angka SELALU dihitung kode; LLM hanya menafsirkan. Tidak ada angka karangan.

import { multiVenueOrderFlowHub } from "../marketdata/multiVenueOrderFlowHub.js";
import { wallLifelines } from "../marketdata/wallLifelines.js";
import { liquidationMapHub } from "../marketdata/liquidationMapHub.js";
import { volumeProfileHub, TIER_FLOORS } from "../marketdata/volumeProfileHub.js";
import { tierFlowHub } from "../marketdata/tierFlowHub.js";

export const PANEL_AI_SCHEMA_VERSION = "artatrade-panel-analysis-v2";

export type PanelId = "orderflow" | "walls" | "liqmap" | "largetrades_vp" | "tierflow" | "combined";

export const PANEL_IDS: PanelId[] = ["orderflow", "walls", "liqmap", "largetrades_vp", "tierflow"];

/** Umur maksimum evidence sumber (ms) sebelum ditandai basi. */
export const PANEL_EVIDENCE_MAX_AGE_MS = 120_000;

/**
 * TAHAP 6B: SEMBAGA waktu dibedakan tegas.
 *  - sourceTsMs  : waktu EVENT di sumber (trade/book/level terakhir). UNKNOWN
 *                  (null) bila sumber tidak memberi tahu — TIDAK diganti
 *                  waktu sekarang.
 *  - receivedAtMs: waktu data DITERIMA oleh proses (bisa > sourceTsMs kalau
 *                  ada delay feed; juga UNKNOWN bila tidak diketahui).
 *  - snapshotAtMs: waktu snapshot dirakit (kode).
 *  - generatedAt : waktu analisis DIBUAT (LLM) — bukan freshness evidence.
 */
export interface PanelEvidence {
  panel: PanelId;
  schemaVersion: string;
  snapshotId: string;
  symbol: string;
  venue: string;
  window: string;
  /** Epoch ms waktu event SUMBER (null = UNKNOWN, bukan "sekarang"). */
  sourceTsMs: number | null;
  /** Epoch ms waktu data diterima proses (null = UNKNOWN). */
  receivedAtMs: number | null;
  /** Epoch ms waktu snapshot dirakit. */
  snapshotAtMs: number;
  /** Umur evidence sumber dalam ms (dihitung dari sourceTsMs). */
  ageMs: number | null;
  status: "fresh" | "stale" | "partial" | "unavailable";
  missingFields: string[];
  data: Record<string, unknown>;
}

/** Brief terstruktur per panel (input LLM — ringkas, tanpa narasi). */
export interface PanelBrief {
  panel: PanelId;
  status: PanelEvidence["status"];
  source: string;
  /** Epoch ms waktu data sumber. */
  sourceTsMs: number | null;
  /** Umur evidence (ms) dihitung saat brief dibuat. */
  ageMs: number | null;
  figures: string[];
  support: string[];
  conflict: string[];
  missing: string[];
  /**
   * Sinyal NUMERIK untuk deteksi konflik lintas panel. Dihitung dari angka
   * asli (bukan dari teks yang sudah diformat) supaya tidak rapuh.
   */
  signals: {
    /** Tanda arah flow utama: +1 / -1 / 0 (0 = tidak diketahui). */
    flowSign: number;
    /** Nilai flow utama (CVD 15m / net tier besar), USD. */
    flowUsd: number;
    /** Arah magnet likuidasi: +1 naik / -1 turun / 0. */
    magnetSign: number;
    /** Umur evidence sumber (ms) — angka kasar untuk UI. */
    ageMs: number | null;
  };
}

function usd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${n < 0 ? "-" : ""}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${n < 0 ? "-" : ""}$${(abs / 1_000).toFixed(1)}K`;
  return `${n < 0 ? "-" : ""}$${abs.toFixed(0)}`;
}

function pct(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

/** Kumpulkan bukti deterministik dari hub live — sumber yang sama dengan API panel. */
export async function gatherPanelEvidence(symbol: string): Promise<PanelEvidence[]> {
  const now = Date.now();
  const out: PanelEvidence[] = [];
  const mk = (panel: PanelId, venue: string, window: string, sourceTsMs: number | null,
    status: PanelEvidence["status"], missingFields: string[], data: Record<string, unknown>,
    receivedAtMs: number | null = null): PanelEvidence => ({
    panel, schemaVersion: PANEL_AI_SCHEMA_VERSION,
    snapshotId: `ev_${panel}_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    symbol, venue, window, sourceTsMs, receivedAtMs, snapshotAtMs: now,
    ageMs: sourceTsMs != null ? Math.max(0, now - sourceTsMs) : null,
    status, missingFields, data,
  });

  // 1) ORDER FLOW — team read 15M & 1H (spot/perp terpisah + harga).
  try {
    const s15 = multiVenueOrderFlowHub.buildSnapshot(symbol, "15m");
    const read = (tf: "15M" | "1H") => {
      const r = s15.teamRead.find((x) => x.timeframe === tf);
      return r ? { priceChangePct: r.priceChangePct, cvdDelta: r.allVenueCvdDelta,
        spotCvd: r.spotCvd, perpCvd: r.perpCvd, buySharePct: r.buySharePct,
        flowVsPrice: r.flowVsPrice } : null;
    };
    const missing: string[] = [];
    if (s15.venuesTrading === 0) missing.push("venues_trading=0");
    else if (s15.venuesTrading < s15.venuesExpected) missing.push(`venues_${s15.venuesTrading}/${s15.venuesExpected}`);
    if (!read("15M")) missing.push("teamRead_15M");
    if (!read("1H")) missing.push("teamRead_1H");
    // Waktu sumber = trade TERAKHIR yang diterima (bukan generatedAt snapshot).
    const srcTs = multiVenueOrderFlowHub.lastTradeAtMs(symbol);
    const srcRecv = multiVenueOrderFlowHub.lastTradeReceivedAtMs(symbol);
    out.push(mk("orderflow", "multi-venue", "15m+1h", srcTs,
      s15.venuesTrading === 0 ? "unavailable" : missing.length ? "partial" : "fresh", missing,
      {
        venuesTrading: s15.venuesTrading, venuesExpected: s15.venuesExpected,
        windowCvd: { allVenues: s15.cvd.allVenues, perpSum: s15.cvd.perpSum, spotSum: s15.cvd.spotSum },
        perVenue: s15.cvd.perVenue.map((v) => ({ venue: v.venue, delta: v.delta, buyUsd: v.buyUsd, sellUsd: v.sellUsd })),
        h15: read("15M"), h1h: read("1H"),
      }, srcRecv));
  } catch (err) {
    out.push(mk("orderflow", "multi-venue", "15m+1h", null, "unavailable", [(err as Error).message], {}));
  }

  // 2) WALL LIFELINES — lifecycle + level wall aktif terbesar.
  try {
    const w = wallLifelines.snapshot(symbol);
    const missing: string[] = [];
    if (!w.summary) missing.push("summary");
    const wallLevels = (w.depth ?? []).filter((d) => d.isWall)
      .sort((a, b) => b.notionalUsd - a.notionalUsd).slice(0, 8)
      .map((d) => ({ side: d.side, price: d.price, notionalUsd: d.notionalUsd, state: d.state }));
    if (wallLevels.length === 0) missing.push("wall_levels");
    // Waktu sumber = book terakhir (bukan updatedAt snapshot).
    const srcTs = wallLifelines.lastBookAtMs(symbol);
    const srcRecv = wallLifelines.lastBookReceivedAtMs(symbol);
    const oldestWall = wallLifelines.oldestLiveWallAtMs(symbol);
    out.push(mk("walls", String(w.venue ?? "BINANCE_PERP"), "30m-retention", srcTs,
      w.summary && w.summary.active > 0 ? "fresh" : w.summary ? "partial" : "unavailable", missing,
      { mid: w.mid, summary: w.summary ?? null, topWalls: wallLevels,
        oldestLiveWallAtMs: oldestWall,
        events: (w.events ?? []).slice(-10).map((e) => ({ type: (e as { type?: string }).type, side: (e as { side?: string }).side,
          price: (e as { price?: number }).price, notionalUsd: (e as { notionalUsd?: number }).notionalUsd, t: (e as { t?: number }).t })),
        trend: w.trend ?? null }, srcRecv));
  } catch (err) {
    out.push(mk("walls", "BINANCE_PERP", "30m-retention", null, "unavailable", [(err as Error).message], {}));
  }

  // 3) LIQ MAP — sumber jujur (vike | hyperliquid_onchain).
  try {
    const lm = await liquidationMapHub.snapshot(symbol);
    const missing: string[] = [];
    if (!lm.bins || lm.bins.length === 0) missing.push("bins");
    if (lm.source !== "vike") missing.push(`source=${lm.source}`);
    out.push(mk("liqmap", String(lm.source ?? "unknown"), "±15%", lm.sourceTsMs ?? lm.updatedAt ?? null,
      lm.stale ? "stale" : lm.bins && lm.bins.length > 0 ? "fresh" : "unavailable", missing,
      { source: lm.source, markPrice: lm.markPrice, magnetDirection: lm.magnetDirection,
        stale: lm.stale, note: lm.note ?? null,
        topClusterBelow: lm.topLongClustersBelow?.[0] ?? null,
        topClusterAbove: lm.topShortClustersAbove?.[0] ?? null,
        binsNonZero: (lm.bins ?? []).filter((b: { longUsd: number; shortUsd: number }) => (b.longUsd ?? 0) > 0 || (b.shortUsd ?? 0) > 0).slice(0, 12) },
      lm.sourceReceivedAtMs ?? null));
  } catch (err) {
    out.push(mk("liqmap", "unknown", "±15%", null, "unavailable", [(err as Error).message], {}));
  }

  // 4) LARGE TRADES + VOLUME PROFILE
  try {
    const vp = volumeProfileHub.build(symbol, "1h");
    const floor = TIER_FLOORS.find((t) => t.tier === "MEDIUM")?.floor ?? 10_000;
    const trades = volumeProfileHub.largeTrades(symbol, floor, 100)
      .filter((t) => now - t.t <= 3600_000).slice(0, 15);
    const missing: string[] = [];
    if (vp.pocPrice == null) missing.push("pocPrice");
    if (vp.totalUsd == null || vp.totalUsd <= 0) missing.push("totalUsd");
    // Waktu sumber = trade terakhir yang masuk profil (bukan updatedAt snapshot).
    const srcTs = volumeProfileHub.lastTradeAtMs(symbol);
    const srcRecv = volumeProfileHub.lastTradeReceivedAtMs(symbol);
    out.push(mk("largetrades_vp", "multi-venue", "1h", srcTs,
      vp.pocPrice != null && (vp.totalUsd ?? 0) > 0 ? (vp.partialWindow ? "partial" : "fresh") : "unavailable",
      missing,
      { pocPrice: vp.pocPrice, vahPrice: vp.vahPrice, valPrice: vp.valPrice,
        priceVsValueArea: vp.priceVsValueArea, totalUsd: vp.totalUsd,
        pocBuySharePct: vp.pocBuySharePct, partialWindow: vp.partialWindow,
        largeTrades: trades, largeTradeFloorUsd: floor }, srcRecv));
  } catch (err) {
    out.push(mk("largetrades_vp", "multi-venue", "1h", null, "unavailable", [(err as Error).message], {}));
  }

  // 5) TIER & FLOW
  try {
    const rangeSec = 3600;
    const tiers = tierFlowHub.tiers(symbol, rangeSec);
    const bias = tierFlowHub.whaleRetailBias(symbol, rangeSec);
    const perEx = tierFlowHub.perExchangeDelta(symbol, rangeSec);
    const div = tierFlowHub.scanDivergences(symbol).slice(0, 5);
    const missing: string[] = [];
    if (!tiers || tiers.length === 0) missing.push("tiers");
    // Tier flow diturunkan dari trade yang sama -> waktu sumber = trade terakhir.
    const srcTs = multiVenueOrderFlowHub.lastTradeAtMs(symbol);
    const srcRecv = multiVenueOrderFlowHub.lastTradeReceivedAtMs(symbol);
    out.push(mk("tierflow", "multi-venue", "1h", srcTs,
      tiers && tiers.length > 0 ? "fresh" : "unavailable", missing,
      { tiers, whaleRetailBias: bias, perExchangeDelta: perEx, divergences: div }, srcRecv));
  } catch (err) {
    out.push(mk("tierflow", "multi-venue", "1h", null, "unavailable", [(err as Error).message], {}));
  }

  return out;
}
