// apps/server/src/api/routes/markets.ts — Batch 4 extraction (FR-30, FR-39, FR-24).
import { Router } from "express";
import type { binanceFuturesClient as BinanceClient } from "../../markets/binanceFuturesClient.js";
import type { defaultMarketsService as MarketsSvc } from "../../markets/marketsService.js";
import type { scannerPool as ScannerPl } from "../../scanner/scannerPool.js";
import type { liquidationHub as LiqHub } from "../../marketdata/liquidationHub.js";
import { klineStreamManager } from "../../marketdata/klineWsManager.js";

export interface MarketsRouterDeps {
  binance: typeof BinanceClient;
  marketsService: typeof MarketsSvc;
  scanner: typeof ScannerPl;
  liquidations: typeof LiqHub;
  gatherMarketContextSnapshot: () => Promise<unknown>;
  gatherPositionOverlays: (symbol?: string) => Promise<unknown>;
  getTvSignal: (symbol: string, interval: string) => Promise<unknown>;
  isPerpListed: (symbol: string) => boolean | null;
  perpUniverseCount: () => number;
  checkAssetClass: (symbol: string, manualBlacklist: ReadonlySet<string>) => { blocked: boolean; reason?: string | null };
  prismaUniverseRepo: { getManualBlacklist(): Promise<string[]> };
  volumeMinUsd: number;
}

export function buildMarketsRouter(deps: MarketsRouterDeps): Router {
  const router = Router();
  const {
    binance,
    marketsService,
    scanner,
    liquidations,
    gatherMarketContextSnapshot,
    gatherPositionOverlays,
    getTvSignal,
    isPerpListed,
    perpUniverseCount,
    checkAssetClass,
    prismaUniverseRepo,
    volumeMinUsd,
  } = deps;

  // ── Scanner & Markets ──────────────────────────────────────────────────────

  /*
     23 Okt 2026: ambang volume operator ditampilkan ke browser supaya UI bisa
     menandai pair di bawah / di atas lantai yang SAMA dengan gate entry.
     Angka ini dibaca dari env.VOLUME_MIN_USD (sumber tunggal kebenaran).
  */
  router.get("/api/markets/volume-floor", (_req, res) => {
    res.json({ volumeMinUsd: volumeMinUsd });
  });

  /*
     23 Okt 2026: daftar simbol lengkap untuk dropdown chart.
     Sebelumnya dropdown chart hard-coded 10 simbol, sehingga pair yang
     sedang di posisi PAPER (SPKUSDT, TAOUSDT, ILVUSDT, TURTLEUSDT, ...)
     tidak bisa dipilih di chart padahal itu pair yang operator pantau.
  */
  router.get("/api/markets/symbols", (_req, res) => {
    try {
      const pairs = binance.getCachedPairs();
      const symbols = pairs
        .map((p) => String(p.symbol || "").toUpperCase())
        .filter((s) => /^[A-Z0-9]{2,20}USDT$/.test(s));
      res.json({ symbols, count: symbols.length, updatedAt: binance.getLastSyncTime() });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.get("/api/markets/scan", (_req, res) => {
    try {
      const view = scanner.getScanView();
      res.json(view);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // FR-30: Top 20 Gainer & Top 20 Loser 24 jam (Real Binance Futures Feed)
  router.get("/api/markets/top", async (req, res) => {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : 20;
      const all = req.query.all === "true" || req.query.all === "1";
      // Refresh from live Binance Futures feed if available
      try {
        await binance.fetchReal24hTickers();
      } catch (e) {
        // Fallback silently to existing tickers
      }
      const result = marketsService.getTopMovers({ limit, all });
      res.json({
        gainers: result.gainers,
        losers: result.losers,
        refreshedAt: result.refreshedAt,
        totalUniverse: result.totalUniverse,
        filteredUniverse: result.filteredUniverse,
        all: result.all,
        limit: result.limit,
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Real-time SSE stream for Top 20 Gainers & Top 20 Losers and Scanner view (FR-30, zero-delay)
  router.get("/api/markets/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    let active = true;
    req.on("close", () => {
      active = false;
    });

    const sendData = () => {
      if (!active) return;
      try {
        const top = marketsService.getTopMovers({ limit: 20, all: req.query.all === "true" });
        const scan = scanner.getScanView();
        const payload = {
          gainers: top.gainers,
          losers: top.losers,
          refreshedAt: top.refreshedAt || Date.now(),
          totalUniverse: top.totalUniverse,
          filteredUniverse: top.filteredUniverse,
          scan,
        };
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch {}
    };

    sendData();

    const unsub = binance.onTickersUpdated(() => {
      if (active) sendData();
    });

    const interval = setInterval(() => {
      if (active) sendData();
    }, 1500);

    req.on("close", () => {
      unsub();
      clearInterval(interval);
    });
  });

  // ── Binance Data ───────────────────────────────────────────────────────────

  // Universal Binance Futures Pairs Catalog (hanya pair CRYPTO yang bisa ditradingkan).
  // Simbol TRADFI (saham/ETF/komoditas/index/FX) difilter keluar dari katalog
  // supaya operator tidak pernah memilih pair non-crypto di terminal.
  router.get("/api/binance/pairs", async (_req, res) => {
    try {
      await binance.fetchReal24hTickers();
      const allPairs = binance.getCachedPairs();
      const manualBlacklist = new Set(await prismaUniverseRepo.getManualBlacklist());
      const blockedNotes: Record<string, string> = {};
      const pairs = allPairs.filter((p) => {
        // ONLY FUTURES: buang simbol di luar allowlist PERPETUAL (spot/delivery).
        if (isPerpListed(p.symbol) === false) {
          blockedNotes[p.symbol] = "NON_PERPETUAL";
          return false;
        }
        const check = checkAssetClass(p.symbol, manualBlacklist);
        if (check.blocked) blockedNotes[p.symbol] = check.reason ?? "BLOCKED";
        return !check.blocked;
      });
      res.json({
        total: pairs.length,
        perpUniverse: perpUniverseCount(),
        minVolumeUsd: volumeMinUsd,
        nonCryptoFiltered: allPairs.length - pairs.length,
        blockedNotes,
        refreshedAt: binance.getLastSyncTime(),
        pairs,
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Live Binance Futures Ticker & Mark Price (FR-39, FR-24)
  router.get("/api/binance/ticker", async (req, res) => {
    try {
      const symbol = String(req.query.symbol || "BTCUSDT").toUpperCase();
      const ticker = await binance.fetchSymbolTicker(symbol);
      if (!ticker) {
        return res.status(404).json({ error: "Symbol not found" });
      }
      res.json(ticker);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Server-Sent Events (SSE) Stream for 100% Guaranteed Live Price & Mark Price sync
  router.get("/api/binance/stream", async (req, res) => {
    const symbol = String(req.query.symbol || "BTCUSDT").toUpperCase();
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    let active = true;
    req.on("close", () => {
      active = false;
    });

    const sendTick = async () => {
      if (!active) return;
      try {
        const tick = await binance.fetchSymbolTicker(symbol);
        if (active && tick) {
          res.write(`data: ${JSON.stringify(tick)}\n\n`);
        }
      } catch {}
    };

    await sendTick();
    const intervalId = setInterval(sendTick, 1000);
    req.on("close", () => {
      clearInterval(intervalId);
    });
  });

  // ── Prices Hub ─────────────────────────────────────────────────────────────

  // Hub harga live ringan (SSE 1 dtk + JSON) untuk markets & terminal. 0 WS, tahan blokir WS.
  const parseHubSymbols = (q: unknown): string[] =>
    String(q || "")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
      // 23 Okt 2026: 100 -> 500. Universe Binance Futures PERP ~500 simbol dan
      // backend sudah memegang WS mark-price untuk semuanya, jadi subscribing
      // seluruh pair itu murah. Batas lama 100 membuat pair di luar 100 pertama
      // tidak pernah updating real-time di dashboard Market.
      .slice(0, 500);

  router.get("/api/prices/live", (req, res) => {
    try {
      binance.startLiveFeeds();
      const { map, ageMs } = binance.getHubPrices(parseHubSymbols(req.query.symbols));
      res.json({ prices: map, count: Object.keys(map).length, ageMs, live: binance.isHubLive(), feed: binance.getFeedHealth() });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.get("/api/prices/stream", (req, res) => {
    const symbols = parseHubSymbols(req.query.symbols);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    binance.startLiveFeeds();
    let active = true;
    req.on("close", () => {
      active = false;
    });

    const send = () => {
      if (!active) return;
      try {
        const { map, ageMs } = binance.getHubPrices(symbols);
        res.write(`data: ${JSON.stringify({ prices: map, ageMs, live: binance.isHubLive(), feed: binance.getFeedHealth() })}\n\n`);
      } catch {}
    };

    send();
    const intervalId = setInterval(send, 1000);
    req.on("close", () => {
      clearInterval(intervalId);
    });
  });

  // ── Klines & Depth ─────────────────────────────────────────────────────────

  /*
     23 Okt 2026 (BUG FIX): route /api/binance/symbol-info TIDAK PERNAH ADA.
     TradingChartPanel memanggilnya untuk mengambil tickSize asli pair
     (line 208), tapi server tidak pernah mendaftarkan route -> 404 ->
     tickSize selalu fallback 0.01.

     Akibatnya pair harga kecil (SPKUSDT 0.0187, ILVUSDT 3.29) ditampilkan
     dengan presisi salah: 0.0187 -> "0.02". Chart & angka jadi tidak akurat.

     Sumber: /fapi/v1/exchangeInfo Binance Futures (resmi, live). Cache 6 jam
     karena tickSize sebuah simbol tidak pernah berubah dalam 1x trading.
  */
  const exchangeInfoCache = new Map<string, { at: number; data: { symbol: string; tickSize: number; stepSize: number; minNotional: number; pricePrecision: number } }>();
  const EXCHANGE_INFO_TTL_MS = 6 * 60 * 60 * 1000;

  router.get("/api/binance/symbol-info", async (req, res) => {
    const symbol = String(req.query.symbol || "").toUpperCase();
    if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol)) {
      res.status(400).json({ error: "INVALID_SYMBOL" });
      return;
    }
    const hit = exchangeInfoCache.get(symbol);
    if (hit && Date.now() - hit.at < EXCHANGE_INFO_TTL_MS) {
      res.json(hit.data);
      return;
    }
    try {
      const info = await binance.fetchSymbolInfo(symbol);
      if (!info) {
        res.status(404).json({ error: "SYMBOL_NOT_FOUND" });
        return;
      }
      exchangeInfoCache.set(symbol, { at: Date.now(), data: info });
      res.json(info);
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  });

  /*
     23 Okt 2026 (BUG FIX KRITIS): route SSE kline-stream TIDAK PERNAH ADA.
     Frontend (apps/web/src/lib/klineStream.ts) membuka EventSource ke
     /api/binance/kline-stream, tapi server tidak pernah mendaftarkan route itu
     -> 404 "Cannot GET" -> EventSource langsung error -> frontend jatuh ke
     polling REST cache. Akibatnya candle TIDAK pernah streaming real-time
     (hanya cache yang basi per TF).

     klineStreamManager (apps/server/src/marketdata/klineWsManager.ts) sudah
     lengkap: satu WS combined untuk semua panel, fan-out ke subscriber.
     Yang hilang hanya jembatan SSE-nya. Route ini yang menyambungkan keduanya.

     Format event: JSON {type:"kline", candle:{...}} — cocok dengan
     parseStreamCandle() di frontend yang menolak payload tanpa type==="kline".
  */
  router.get("/api/binance/kline-stream", (req, res) => {
    const symbol = String(req.query.symbol || "").toUpperCase();
    const interval = String(req.query.interval || "1m").toLowerCase();
    if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol) || !/^(1m|3m|5m|15m|1h|4h|1d)$/.test(interval)) {
      res.status(400).json({ error: "INVALID_KLINE_SUBSCRIPTION" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // nginx tidak boleh buffer SSE
    res.flushHeaders?.();

    let active = true;
    const write = (payload: unknown) => {
      if (!active) return;
      try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { /* client gone */ }
    };

    // Subscribe DULU, baru tulis status: kline pertama bisa tiba sebelum
    // frame status — urutan salah membuat frontend sempat menandai DEGRADED.
    const unsubscribe = klineStreamManager.subscribe(symbol, interval, (candle) => {
      write({ type: "kline", candle });
    });

    const statusTimer = setInterval(() => {
      const health = klineStreamManager.health();
      write({
        type: "status",
        connected: health.connected,
        status: health.status,
        lastEventAgeMs: health.lastEventAgeMs,
        lastError: health.lastError,
        subscribers: health.subscribers,
        streams: health.streams,
      });
    }, 1000);

    write({ type: "status", connected: klineStreamManager.health().connected, status: klineStreamManager.health().status, lastEventAgeMs: null, lastError: null });

    req.on("close", () => {
      active = false;
      clearInterval(statusTimer);
      unsubscribe();
    });
  });

  router.get("/api/binance/kline-stream/health", (_req, res) => {
    res.json(klineStreamManager.health());
  });

  /*
     23 Okt 2026 (BUG FIX LIMIT KONEKSI BROWSER): route di atas memakai SATU
     EventSource per panel. Chrome membatasi 6 koneksi HTTP/1.1 per host,
     jadi layout 8 monitor memakai 8 EventSource -> 2-3connections antre dan
     tidak pernah sampai ke server (subscriber hanya 5 dari 8, panel sisanya
     selamanya "WS CONNECTING").

     Solusi: route MULTIPLEX — satu SSE melayani BANYAK pasangan
     symbol:interval, dengan format "sym:tf,sym:tf,...". Frontend
     membuka SATU EventSource untuk seluruh panel dan mencocokkan candle
     per panel. Backend tetap pakai satu WS combined (sudah ada).
  */
  router.get("/api/binance/kline-stream-multi", (req, res) => {
    const raw = String(req.query.pairs || "").trim();
    if (!raw) {
      res.status(400).json({ error: "MISSING_PAIRS" });
      return;
    }
    const pairs = raw.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean).slice(0, 64);
    const parsed: Array<{ symbol: string; interval: string }> = [];
    for (const p of pairs) {
      const [symbol, interval] = p.split(":");
      if (!symbol || !interval) continue;
      const sym = symbol.toUpperCase();
      const iv = interval.toLowerCase();
      if (!/^[A-Z0-9]{2,20}USDT$/.test(sym) || !/^(1m|3m|5m|15m|1h|4h|1d)$/.test(iv)) continue;
      parsed.push({ symbol: sym, interval: iv });
    }
    if (!parsed.length) {
      res.status(400).json({ error: "INVALID_PAIRS" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    let active = true;
    const write = (payload: unknown) => {
      if (!active) return;
      try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { /* client gone */ }
    };

    const unsubscribes = parsed.map((p) =>
      klineStreamManager.subscribe(p.symbol, p.interval, (candle) => {
        write({ type: "kline", candle });
      }),
    );

    const statusTimer = setInterval(() => {
      const health = klineStreamManager.health();
      write({
        type: "status",
        connected: health.connected,
        status: health.status,
        lastEventAgeMs: health.lastEventAgeMs,
        lastError: health.lastError,
        subscribers: health.subscribers,
        streams: health.streams,
      });
    }, 1000);

    write({ type: "status", connected: klineStreamManager.health().connected, status: klineStreamManager.health().status, lastEventAgeMs: null, lastError: null });

    req.on("close", () => {
      active = false;
      clearInterval(statusTimer);
      for (const u of unsubscribes) { try { u(); } catch { /* ignore */ } }
    });
  });

  // 27 Okt 2026 (fix "chart lemot"): cache in-memory 30 dtk per symbol+interval.
  // Banyak panel (chart posisi, heatmap, mini-chart) meminta kline yang sama
  // hampir bersamaan; tanpa cache tiap request ke Binance REST. Data tetap
  // segar: candle berjalan sudah di-update via WS di sisi client.
  const klineCache = new Map<string, { at: number; klines: unknown[] }>();
  router.get("/api/binance/klines", async (req, res) => {
    try {
      const symbol = String(req.query.symbol || "BTCUSDT").toUpperCase();
      const interval = String(req.query.interval || "15m");
      const limit = Number(req.query.limit) || 100;
      const key = `${symbol}|${interval}|${limit}`;
      const hit = klineCache.get(key);
      if (hit && Date.now() - hit.at < 30_000) {
        res.json({ symbol, interval, klines: hit.klines, cached: true });
        return;
      }
      const klines = await binance.fetchKlines(symbol, interval, limit);
      klineCache.set(key, { at: Date.now(), klines });
      if (klineCache.size > 200) {
        const oldest = klineCache.keys().next().value;
        if (oldest !== undefined) klineCache.delete(oldest);
      }
      res.json({ symbol, interval, klines });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // 14 Okt 2026 (permintaan operator): order book depth + liquidation feed
  // untuk HEATMAP real-time (order book/liquidity heatmap + liquidation heatmap).
  // Sumber resmi Binance: /fapi/v1/depth + stream !forceOrder@arr (no API key).
  router.get("/api/binance/depth", async (req, res) => {
    try {
      const symbol = String(req.query.symbol || "BTCUSDT").toUpperCase();
      const limit = Number(req.query.limit) || 500;
      res.json({ symbol, serverTime: Date.now(), ...(await binance.fetchDepth(symbol, limit)) });
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  });

  // ── Liquidations ───────────────────────────────────────────────────────────

  router.get("/api/liquidations", async (req, res) => {
    try {
      liquidations.start(); // lazy — koneksi WS hanya hidup saat dipakai
      const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : undefined;
      const limit = Math.min(500, Number(req.query.limit) || 200);
      const recent = liquidations.recent(symbol, limit);
      res.json({
        status: liquidations.status(),
        ...recent,
        summary: liquidations.summary(Number(req.query.windowMin) || 60),
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── Market Intelligence ────────────────────────────────────────────────────

  // 14 Okt 2026 (master task Fase 3+7): Market Intelligence snapshot —
  // fitur deterministik (breadth, regime, RS BTC, likuiditas, likuidasi,
  // data_quality) dengan schema artatrade-market-intelligence-v1. Read-only.
  router.get("/api/market-intel", async (_req, res) => {
    try {
      res.json(await gatherMarketContextSnapshot());
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── Position Overlay & TV Signal ───────────────────────────────────────────

  // 14 Okt 2026 (Part A): overlay posisi terkonfirmasi untuk chart terminal —
  // read-only, idempoten per positionId. TIDAK pernah mengirim/modify order.
  router.get("/api/positions/overlay", async (req, res) => {
    try {
      const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : undefined;
      res.json({ fetchedAt: Date.now(), positions: await gatherPositionOverlays(symbol) });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // 8 Okt 2026 (permintaan operator): sinyal BUY/SELL TradingView (technical
  // rating) + rencana level prediksi entry/SL/TP (model ArtaTrade, ATR14).
  // Read-only untuk display chart — BUKAN jalur trading (tidak memengaruhi order).
  router.get("/api/tv/signal", async (req, res) => {
    try {
      const symbol = String(req.query.symbol || "BTCUSDT").toUpperCase();
      const interval = String(req.query.interval || "15m");
      res.json(await getTvSignal(symbol, interval));
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  });

  return router;
}
