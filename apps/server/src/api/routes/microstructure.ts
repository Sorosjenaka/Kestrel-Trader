// apps/server/src/api/routes/microstructure.ts
// 24 Okt 2026 — Route REST + SSE untuk 5 modul mikrostruktur.
//
//  GET  /api/orderflow/summary
//  GET  /api/orderflow/:symbol?window=15m|1h|session
//  GET  /api/orderflow/:symbol/stream           (SSE, ~1.5 dtk)
//  GET  /api/walls/:symbol
//  GET  /api/walls/:symbol/stream                (SSE, ~1.5 dtk)
//  GET  /api/liquidation-map/:symbol
//  GET  /api/large-trades?symbol&tier&range=1h|1d|7d
//  GET  /api/volume-profile/:symbol?range=1h|1d|7d
//  GET  /api/tier-flow/:symbol?range=15m|1h|1d|7d
//
// CATATAN: data 100% dari stream WS/REST exchange live + Vike. Tidak ada
// fallback mock: bila sumber belum siap, endpoint melaporkan statusnya.

import { Router } from "express";
import { logger } from "../../core/logger.js";
import { multiVenueOrderFlowHub } from "../../marketdata/multiVenueOrderFlowHub.js";
import { wallLifelines } from "../../marketdata/wallLifelines.js";
import { liquidationMapHub } from "../../marketdata/liquidationMapHub.js";
import { volumeProfileHub, TIER_FLOORS } from "../../marketdata/volumeProfileHub.js";
import { tierFlowHub, DIVERGENCE_MIN_SPREAD_USD } from "../../marketdata/tierFlowHub.js";
import { VENUES, TRACKED_SYMBOLS, EXCHANGE_ORDER } from "../../marketdata/microstructureTypes.js";
import { cached } from "./microstructureCache.js";

const SYMBOL_RE = /^[A-Z0-9]{2,20}$/;
const RANGE_SECONDS: Record<string, number> = { "15m": 900, "1h": 3600, "1d": 86400, "7d": 604800 };

function cleanSymbol(raw: string | undefined): string | null {
  const s = String(raw ?? "").trim().toUpperCase();
  if (!SYMBOL_RE.test(s)) return null;
  return s;
}

/** Setup SSE standar (header, flush, heartbeat). */
function beginSse(res: import("express").Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
}

/**
 * 24 Okt 2026 — helper SSE generik.
 *
 * Semua modul mikrostruktur memakai pola yang sama: kirim satu frame awal
 * (halaman terisi seketika), lalu push ulang tiap `intervalMs`.
 *
 * `produce` dipanggil lewat `cached()` supaya snapshot dihitung SATU KALI
 * per tick dan dipakai bersama semua klien yang terhubung — bukan dihitung
 * ulang per klien. Tanpa ini, 3 tab browser = 3 hitung identik tiap 1.5 dtk.
 */
function streamSse(
  res: import("express").Response,
  req: import("express").Request,
  opts: { type: string; intervalMs: number; cacheKey: string; produce: () => unknown | Promise<unknown> },
): void {
  beginSse(res);
  let active = true;

  const write = (payload: unknown) => {
    if (!active) return;
    try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { /* client gone */ }
  };

  // 26 Okt 2026 (TAHAP 3A — SSE & freshness): error producer TIDAK BOLEH
  // tampil seperti data segar. Simpan snapshot valid terakhir; bila producer
  // gagal, kirim frame {type,error,lastValid:{data,at},status:"ERROR"} —
  // klien memakai `error`/`status` untuk menandai stale dan melanjutkan
  // fallback, BUKAN memperbarui timestamp data valid.
  let lastValid: { data: unknown; at: number } | null = null;
  const push = () => {
    if (!active) return;
    // TTL cache sengaja JAUH lebih kecil dari interval push (400 ms vs
    // 1500 ms): tujuannya BUKAN menyajikan data basi, melainkan menggabungkan
    // (coalesce) permintaan yang datang dari beberapa klien dalam waktu
    // berdekatan supaya snapshot dihitung SATU KALI per tick, bukan N kali.
    void cached(opts.cacheKey, 400, opts.produce)
      .then((data) => {
        lastValid = { data, at: Date.now() };
        write({ type: opts.type, data, status: "OK" });
      })
      .catch((err) => write({
        type: opts.type,
        error: (err as Error).message,
        status: lastValid ? "ERROR_STALE" : "ERROR",
        lastValid: lastValid ? { data: lastValid.data, at: lastValid.at } : null,
      }));
  };

  push(); // frame pertama langsung

  const timer = setInterval(push, opts.intervalMs);
  req.on("close", () => {
    active = false;
    clearInterval(timer);
  });
}

export function buildMicrostructureRouter(): Router {
  const router = Router();

  // ── Panel 1 — Order flow ────────────────────────────────────────────────

  router.get("/api/orderflow/summary", (_req, res) => {
    res.json({
      generatedAt: Date.now(),
      venues: multiVenueOrderFlowHub.venueHealth(),
      venuesExpected: VENUES.length,
      exchangeOrder: EXCHANGE_ORDER,
      trackedSymbols: TRACKED_SYMBOLS,
      hubStartedAt: multiVenueOrderFlowHub.startedAtMs,
      tierDivergenceMinSpreadUsd: DIVERGENCE_MIN_SPREAD_USD,
      // 25 Okt 2026 — transaksi dibuang karena waktu di luar rentang (satuan
      // timestamp bursa salah / jam bursa menyimpang). Diekspos supaya
      // operator bisa membedakan "tidak ada trade" dari "trade dibuang".
      droppedInvalidTime: multiVenueOrderFlowHub.droppedInvalidTimeCount,
    });
  });

  router.get("/api/orderflow/:symbol", (req, res) => {
    const symbol = cleanSymbol(req.params.symbol);
    if (!symbol) { res.status(400).json({ error: "SYMBOL_INVALID" }); return; }
    const rawWindow = String(req.query.window ?? "15m").toLowerCase();
    const window = (["15m", "1h", "session"].includes(rawWindow) ? rawWindow : "15m") as "15m" | "1h" | "session";
    res.json(multiVenueOrderFlowHub.buildSnapshot(symbol, window));
  });

  router.get("/api/orderflow/:symbol/stream", (req, res) => {
    const symbol = cleanSymbol(req.params.symbol);
    if (!symbol) { res.status(400).json({ error: "SYMBOL_INVALID" }); return; }
    const rawWindow = String(req.query.window ?? "15m").toLowerCase();
    const window = (["15m", "1h", "session"].includes(rawWindow) ? rawWindow : "15m") as "15m" | "1h" | "session";

    streamSse(res, req, {
      type: "orderflow",
      intervalMs: 1500,
      cacheKey: `orderflow:${symbol}:${window}`,
      produce: () => multiVenueOrderFlowHub.buildSnapshot(symbol, window),
    });
  });

  // ── Panel 2 — Wall lifelines ─────────────────────────────────────────────

  router.get("/api/walls/:symbol", (req, res) => {
    const symbol = cleanSymbol(req.params.symbol);
    if (!symbol) { res.status(400).json({ error: "SYMBOL_INVALID" }); return; }
    res.json(wallLifelines.snapshot(symbol));
  });

  router.get("/api/walls/:symbol/stream", (req, res) => {
    const symbol = cleanSymbol(req.params.symbol);
    if (!symbol) { res.status(400).json({ error: "SYMBOL_INVALID" }); return; }
    streamSse(res, req, {
      type: "walls",
      intervalMs: 1500,
      cacheKey: `walls:${symbol}`,
      produce: () => wallLifelines.snapshot(symbol),
    });
  });

  // ── Panel 3 — Liquidation map ────────────────────────────────────────────

  router.get("/api/liquidation-map/:symbol", async (req, res) => {
    const symbol = cleanSymbol(req.params.symbol);
    if (!symbol) { res.status(400).json({ error: "SYMBOL_INVALID" }); return; }
    try {
      res.json(await liquidationMapHub.snapshot(symbol));
    } catch (err) {
      res.status(502).json({ error: "LIQUIDATION_MAP_UNAVAILABLE", detail: (err as Error).message });
    }
  });

  router.get("/api/liquidation-map/:symbol/stream", (req, res) => {
    const symbol = cleanSymbol(req.params.symbol);
    if (!symbol) { res.status(400).json({ error: "SYMBOL_INVALID" }); return; }
    streamSse(res, req, {
      type: "liquidation-map",
      intervalMs: 1500,
      cacheKey: `liquidation-map:${symbol}`,
      // snapshot() async (Vike HTTP + fallback sampling) — `cached` mendukung
      // Promise dan meng-coalesce panggilan bersamaan.
      produce: () => liquidationMapHub.snapshot(symbol),
    });
  });

  // ── Panel 4 — Large trades & volume profile ──────────────────────────────

  /** Snapshot "large trades" untuk symbol+tier+range (dipakai REST & SSE). */
  const buildLargeTrades = (symbol: string | null, tier: string, range: string) => {
    const rangeSec = RANGE_SECONDS[range] ?? 3600;
    const floor = TIER_FLOORS.find((t) => t.tier === tier)?.floor ?? 10_000;
    const trades = volumeProfileHub.largeTrades(symbol, floor, 200);
    const now = Date.now();
    const inRange = trades.filter((t) => now - t.t <= rangeSec * 1000);
    return {
      symbol,
      tier,
      range,
      floorUsd: floor,
      generatedAt: now,
      count: inRange.length,
      tierCounts: volumeProfileHub.tierCounts(symbol, floor),
      trades: inRange,
    };
  };

  router.get("/api/large-trades", (req, res) => {
    const symbol = cleanSymbol(String(req.query.symbol ?? ""));
    const tier = String(req.query.tier ?? "SMALL").toUpperCase();
    const range = String(req.query.range ?? "1h").toLowerCase();
    res.json(buildLargeTrades(symbol, tier, range));
  });

  router.get("/api/large-trades/stream", (req, res) => {
    const symbol = cleanSymbol(String(req.query.symbol ?? ""));
    const tier = String(req.query.tier ?? "SMALL").toUpperCase();
    const range = String(req.query.range ?? "1h").toLowerCase();
    streamSse(res, req, {
      type: "large-trades",
      intervalMs: 1500,
      cacheKey: `large-trades:${symbol ?? ""}:${tier}:${range}`,
      produce: () => buildLargeTrades(symbol, tier, range),
    });
  });

  router.get("/api/volume-profile/:symbol", (req, res) => {
    const symbol = cleanSymbol(req.params.symbol);
    if (!symbol) { res.status(400).json({ error: "SYMBOL_INVALID" }); return; }
    const raw = String(req.query.range ?? "1h").toLowerCase();
    const range = (["1h", "1d", "7d"].includes(raw) ? raw : "1h") as "1h" | "1d" | "7d";
    res.json(volumeProfileHub.build(symbol, range));
  });

  router.get("/api/volume-profile/:symbol/stream", (req, res) => {
    const symbol = cleanSymbol(req.params.symbol);
    if (!symbol) { res.status(400).json({ error: "SYMBOL_INVALID" }); return; }
    const raw = String(req.query.range ?? "1h").toLowerCase();
    const range = (["1h", "1d", "7d"].includes(raw) ? raw : "1h") as "1h" | "1d" | "7d";
    streamSse(res, req, {
      type: "volume-profile",
      intervalMs: 1500,
      cacheKey: `volume-profile:${symbol}:${range}`,
      produce: () => volumeProfileHub.build(symbol, range),
    });
  });

  // ── Panel 5 — Tier & flow ────────────────────────────────────────────────

  /** Snapshot tier & flow (dipakai REST & SSE). */
  const buildTierFlow = (symbol: string, range: string, rangeSec: number) => {
    // 25 Okt 2026 (FASE 5): window harus jujur soal coverage. Akumulasi
    // tier/per-exchange memakai ring per-menit dengan retensi 2 hari — untuk
    // range 7d angka yang tersedia HANYA sejauh retensi itu (backfill resmi
    // untuk agregat kustom ini tidak tersedia), jadi dilaporkan sebagai
    // PARTIAL_HISTORY beserta rentang yang benar-benar tercakup.
    const RETENTION_SEC = 2880 * 60;
    const coveredSec = Math.min(rangeSec, RETENTION_SEC);
    return {
      symbol,
      range,
      rangeSec,
      generatedAt: Date.now(),
      history: {
        status: coveredSec < rangeSec ? "PARTIAL_HISTORY" : "FULL_WINDOW",
        requestedFrom: Date.now() - rangeSec * 1000,
        coverageFrom: Date.now() - coveredSec * 1000,
        coverageSec: coveredSec,
        retentionSec: RETENTION_SEC,
      },
      tiers: tierFlowHub.tiers(symbol, rangeSec),
      perExchange: tierFlowHub.perExchangeSeries(symbol, rangeSec),
      perExchangeTotals: tierFlowHub.perExchangeDelta(symbol, rangeSec),
      divergenceAlerts: tierFlowHub.recentAlerts(25),
      divergenceMinSpreadUsd: DIVERGENCE_MIN_SPREAD_USD,
      alertsScannedAt: tierFlowHub.alertsScannedAt,
      whaleRetailBias: tierFlowHub.whaleRetailBias(symbol, rangeSec),
    };
  };

  router.get("/api/tier-flow/:symbol", (req, res) => {
    const symbol = cleanSymbol(req.params.symbol);
    if (!symbol) { res.status(400).json({ error: "SYMBOL_INVALID" }); return; }
    const raw = String(req.query.range ?? "1h").toLowerCase();
    const rangeSec = RANGE_SECONDS[raw] ?? 3600;
    const range = raw in RANGE_SECONDS ? raw : "1h";
    res.json(buildTierFlow(symbol, range, rangeSec));
  });

  router.get("/api/tier-flow/:symbol/stream", (req, res) => {
    const symbol = cleanSymbol(req.params.symbol);
    if (!symbol) { res.status(400).json({ error: "SYMBOL_INVALID" }); return; }
    const raw = String(req.query.range ?? "1h").toLowerCase();
    const rangeSec = RANGE_SECONDS[raw] ?? 3600;
    const range = raw in RANGE_SECONDS ? raw : "1h";
    streamSse(res, req, {
      type: "tier-flow",
      intervalMs: 1500,
      cacheKey: `tier-flow:${symbol}:${range}`,
      produce: () => buildTierFlow(symbol, range, rangeSec),
    });
  });

  // ── Health modul (bukti data hidup) ──────────────────────────────────────

  router.get("/api/microstructure/health", (_req, res) => {
    const venues = multiVenueOrderFlowHub.venueHealth();
    const totalTrades = venues.reduce((a, v) => a + v.tradesIngested, 0);
    res.json({
      generatedAt: Date.now(),
      orderFlow: {
        started: multiVenueOrderFlowHub.isStarted,
        startedAt: multiVenueOrderFlowHub.startedAtMs,
        venuesConnected: venues.filter((v) => v.connected).length,
        venuesTotal: venues.length,
        totalTradesIngested: totalTrades,
        venues: venues.map((v) => ({
          venue: v.venue, label: v.label, connected: v.connected,
          messages: v.messages, reconnects: v.reconnects,
          tradesIngested: v.tradesIngested,
          lastMessageAgeMs: v.lastMessageAtMs ? Date.now() - v.lastMessageAtMs : null,
          lastError: v.lastError,
        })),
      },
      walls: { started: true },
      liquidationMap: {
        started: liquidationMapHub.isStarted,
        lastError: liquidationMapHub.lastErrorMessage,
      },
      volumeProfile: { started: Date.now() - volumeProfileHub.startedAtMs > 0 },
      tierFlow: { started: Date.now() - tierFlowHub.startedAtMs > 0 },
    });
  });

  return router;
}
