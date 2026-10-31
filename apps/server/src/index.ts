// Private Trade AI - entrypoint server (NFR-04).
import { createApp, measureClockDrift, setClockDrift } from "./app.js";
import { defaultPositionReconciler } from "./exec/reconciler.js";
import { autonomousTradingBot } from "./exec/autonomousTradingBot.js";
import { binanceFuturesClient } from "./markets/binanceFuturesClient.js";
import { UniverseManager, prismaUniverseRepo } from "./universe/universeManager.js";
import { startLeverageSync } from "./universe/leverageSync.js";
import { marketSweep } from "./agents/marketSweep.js";
import { exchangeNonCryptoCount } from "./universe/assetClassGuard.js";
import { env } from "./core/env.js";
import { logger } from "./core/logger.js";
import { defaultDailyRiskGuard } from "./risk/dailyGuard.js";
import { startAutomatedPlaybookRuleRunner } from "./learning/playbookRules.js";
import { defaultSwingEvaluationLoop } from "./learning/swingEvalLoop.js";
import { SWING_EVAL_IDS } from "./learning/swingEvalRegistry.js";
import { exchangeReconcileSource, livePositionWatcher, LIVE_MODE, liveBracketCleanup, liveExchange, moveSlToBeLive } from "./exec/liveRuntime.js";
import { liveProtectionMonitor } from "./exec/liveProtectionMonitor.js";
import { defaultPositionSupervisor } from "./exec/positionSupervisor.js";
import { db as coreDb } from "./core/db.js";
import { PositionReconciler } from "./exec/reconciler.js";
import { pruneDatabase } from "./core/maintenance.js";
import { startMicrostructureHubs } from "./marketdata/microstructureBootstrap.js";

const app = createApp();

const drift = await measureClockDrift();
setClockDrift(drift);

// NFR-04, NFR-14: Reconcile posisi saat server boot.
// 10 Okt 2026 (jalur LIVE): di mode LIVE reconciler memakai snapshot posisi
// exchange asli (exchangeReconcileSource).
// 25 Okt 2026 (G4): gate LIVE_MODE dihapus — reconciler mode-independent.
// Snapshot exchange (GET signed) dibaca juga saat PAPER supaya posisi live
// yang tidak punya baris DB (GTC/WLD/BOME/MOODENG) terdeteksi sebagai ORPHAN
// di EventLog, bukan diam-diam diabaikan. Posisi PAPER sendiri tetap
// SIMULATED_KEPT (lihat exec/reconciler.ts). Tanpa API key = fallback offline.
try {
  if (exchangeReconcileSource) {
    await new PositionReconciler({ exchange: exchangeReconcileSource }).reconcile();
  } else {
    await defaultPositionReconciler.reconcile();
  }
} catch (err) {
  logger.error({ err }, "Gagal menjalankan boot reconcile");
}

// LIVE: watcher posisi exchange (SL/TP resting yang menutup posisi).
try {
  livePositionWatcher.start();
} catch (err) {
  logger.error({ err }, "Gagal menyalakan live position watcher");
}

// A2 (30 Okt 2026): monitor proteksi — posisi LIVE tanpa SL aktif di exchange
// -> EventLog CRITICAL (alert feed). Read-only, loop 60 dtk, tidak menyentuh
// logika trading. Lihat exec/liveProtectionMonitor.ts.
try {
  liveProtectionMonitor.start();
} catch (err) {
  logger.error({ err }, "Gagal menyalakan live protection monitor");
}

// Orphan SL/TP cleanup (13 Okt, insiden Position 3028/3029): hook supervisor +
// sweep startup. Posisi FLAT (bukti exchange) = proteksi sibling SLA_/TPA_ milik
// trade itu dibatalkan + diverifikasi (cancelWithConfirmation). Aman diulang
// (idempotent); ambigu/tidak milik bot = tidak disentuh (fail-closed).
if (LIVE_MODE) {
  defaultPositionSupervisor.setFullyClosedHook((pos, reason) => liveBracketCleanup(pos, reason));
  // Ladder SWING: setelah TP2/final terisi, geser algo SL di exchange
  // ke BE (entry). Fail-open di dalam moveSlToBeLive; ARM live tidak tersentuh.
  defaultPositionSupervisor.setBeMoveHook((pos) => moveSlToBeLive(pos));
  // Startup sweep: algo SLA_/TPA_ NEW yang tersisa dari posisi LIVE_ yang sudah
  // CLOSED di DB (server sempat mati sebelum cleanup). Selain itu lapis watchdog
  // (sweep_orphan_protective) menangkap orphan di luar jendela DB-7-hari ini.
  void (async () => {
    try {
      if (!liveExchange) return;
      const sevenDaysAgo = Date.now() - 7 * 24 * 3600_000;
      const candidates = await coreDb.position.findMany({
        where: { status: "CLOSED", closedAt: { gte: new Date(sevenDaysAgo) },
          source: { startsWith: "LIVE_" } },
        select: { id: true, symbol: true },
        orderBy: { closedAt: "desc" },
        take: 200,
      });
      let swept = 0;
      for (const c of candidates) {
        await liveBracketCleanup(c, "STARTUP_SWEEP");
        swept++;
      }
      logger.info({ candidates: candidates.length, swept }, "BRACKET_STARTUP_SWEEP_DONE");
    } catch (err) {
      logger.error({ err }, "BRACKET_STARTUP_SWEEP_FAILED");
    }
  })();
}

// FR-01, FR-02, US-03: Sinkron universe exchangeInfo saat boot + tiap 30 menit.
// Selain mengisi tabel Symbol (blacklist non-crypto), sync SUKSES mengisi
// registry dinamis guard entry (setExchangeNonCrypto) — kunci blacklist
// saham/ETF/komoditas yang terus bertambah di Binance. Gagal sync TIDAK
// menghapus registry lama dan tidak menggagalkan boot (guard statis tetap jalan).
const universeManager = new UniverseManager({
  get: <T>(path: string) => binanceFuturesClient.fetchPublic<T>(path),
  repo: prismaUniverseRepo,
  // 14 Okt 2026: volume 24h -> tabel Symbol (audit universe "Lolos N" hidup kembali).
  fetchVolumes: async () => {
    const tickers = await binanceFuturesClient.fetchReal24hTickers();
    const map = new Map<string, number>();
    for (const t of tickers) {
      const sym = String((t as { symbol?: string }).symbol ?? "").toUpperCase();
      const qv = Number((t as { quoteVolume?: string | number }).quoteVolume) || 0;
      if (sym && qv > 0) map.set(sym, qv);
    }
    return map;
  },
  onEvent: (type, payload) => logger.info(payload, `UNIVERSE_${type}`),
});
try {
  await universeManager.syncOnce();
  logger.info(
    { dynamicBlocked: exchangeNonCryptoCount() },
    "Universe sync boot selesai — penjaga kelas aset memakai daftar exchangeInfo live",
  );
} catch (err) {
  logger.error({ err }, "Universe sync boot gagal — guard memakai daftar statis fallback");
}
universeManager.start();

// FR-16, US-14: sinkron snapshot max leverage saat boot + tiap 6 jam (desain asli
// T-1.5 yang sebelumnya tidak pernah dipasangkan pemanggilnya — 4 Okt 2026 seluruh
// snapshot basi serentak sehingga gate FR-16 memblokir semua entry). Gagal sync
// (mis. key/IP ditolak Binance) dicatat LEVERAGE_SYNC_FAIL dan boot tetap jalan.
try {
  startLeverageSync();
} catch (err) {
  logger.error({ err }, "Gagal menyalakan leverage sync");
}

// LLM Market Sweep (15 Okt): riset multi-paralel semua simbol — lapisan riset
// read-only, timer sendiri, tidak pernah memblokir bot. Hanya bila key LLM ada.
try {
  if (env.LLM_SWEEP_ENABLED && env.XKIRO_API_KEY) marketSweep.start();
} catch (err) {
  logger.error({ err }, "Gagal menyalakan LLM market sweep");
}

// Hub harga live untuk markets & terminal (jalan walau bot di-stop).
// startLiveFeeds: 1x WS futures !markPrice@arr (asli) + 1x WS spot vision (jaminan)
// + snapshot REST hemat max 1x/60 dtk — nol polling agresif, anti ban 418.
try {
  binanceFuturesClient.startLiveFeeds();
} catch (err) {
  logger.error({ err }, "Gagal menyalakan live price feed");
}

// 24 Okt 2026 — 5 modul mikrostruktur: 10 koneksi WS multi-venue (24/7 di
// backend, bukan polling dari browser), wall lifelines, peta likuidasi,
// large trades + volume profile, tier & flow. Jalan walau bot di-stop.
try {
  await startMicrostructureHubs();
} catch (err) {
  logger.error({ err }, "Gagal menyalakan hub mikrostruktur");
}

// Restore the persisted ARM choice before starting any entry cycle. A restart
// during a drawdown must not silently re-arm a bot the operator disarmed.
try {
  await defaultDailyRiskGuard.restoreArmedState();
} catch (err) {
  logger.error({ err }, "Gagal memulihkan ARM; entry dinonaktifkan demi keselamatan");
  await defaultDailyRiskGuard.setArmed(false, "ARM_RESTORE_FAILED").catch(() => undefined);
}

// FR-26, FR-30, FR-32: Auto-start Autonomous Trading Bot & Market Scanner
try {
  autonomousTradingBot.start();
  startAutomatedPlaybookRuleRunner(60_000);
  // Swing evaluation loop: five registered subjects, persistent state, LLM +
  // backtest/gate/paper adapters. It never submits exchange orders and never
  // changes active strategy/risk/exit config.
  try {
    if (process.env.SWING_EVAL_LOOP_ENABLED === "false") {
      logger.warn("Swing evaluation loop DISABLED by SWING_EVAL_LOOP_ENABLED=false");
    } else {
      const queued = defaultSwingEvaluationLoop.bootstrap();
      defaultSwingEvaluationLoop.start();
      logger.info({ queued, activeSubjects: SWING_EVAL_IDS.length }, "Swing evaluation loop aktif (three active subjects)");
    }
  } catch (err) {
    logger.error({ err }, "Swing evaluation loop gagal start (tidak memblokir trading PAPER)");
  }
  logger.info("Autonomous Trading Bot & Market Scanner berhasil diaktifkan saat boot");
} catch (err) {
  logger.error({ err }, "Gagal menyalakan Autonomous Trading Bot");
}

// Deploy VPS: backend HANYA di localhost:8787 -> akses publik lewat nginx (port 80).
app.listen(env.PORT, "127.0.0.1", () => {
  logger.info(
    { port: env.PORT, driftMs: drift },
    "Private Trade AI server berjalan (ARM=" + (defaultDailyRiskGuard.isArmed() ? "ON" : "OFF") + ", execution=" + env.BINANCE_EXECUTION_MODE + ", liveReady=false)",
  );
});

// ── 15 Okt 2026 — TAHAP 7 rencana audit: AUTO-PRUNE harian di jam sepi ─────
// Retensi EventLog 3 hari memblokir event loop >10 menit bila dijalankan saat
// boot (insiden 14 Okt). Kini dijadwalkan INTERNAL tiap hari di 04:30 WIB
// (21:30 UTC) — jam paling sepi — lewat pruneDatabase (deleteMany bertahap +
// wal_checkpoint + VACUUM). Cek tiap 15 menit, idempoten per hari.
const _pruneUtcHour = 21, _pruneUtcMinute = 30;
let _lastPruneDayKey = "";
setInterval(() => {
  const now = new Date();
  const dayKey = now.toISOString().slice(0, 10);
  if (dayKey === _lastPruneDayKey) return;
  if (now.getUTCHours() !== _pruneUtcHour || now.getUTCMinutes() < _pruneUtcMinute) return;
  _lastPruneDayKey = dayKey;
  void pruneDatabase({}).then((r) => {
    logger.info({ ...r }, "AUTO_PRUNE_HARIAN selesai (jam sepi 04:30 WIB)");
  }).catch((err) => {
    logger.warn({ err: (err as Error).message }, "AUTO_PRUNE_HARIAN gagal (dipercoba besok)");
    _lastPruneDayKey = ""; // boleh dicoba lagi dalam hari yang sama
  });
}, 15 * 60_000);
