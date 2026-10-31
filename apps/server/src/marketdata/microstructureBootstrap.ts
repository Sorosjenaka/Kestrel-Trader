// apps/server/src/marketdata/microstructureBootstrap.ts
// 24 Okt 2026 — Bootstrap 5 modul mikrostruktur.
//
// Satu titik start/stop untuk:
//   1. multiVenueOrderFlowHub  (10 venue WS, CVD, book, HL stats)
//   2. wallLifelines           (siklus hidup dinding L2)
//   3. liquidationMapHub       (peta likuidasi ±15%)
//   4. volumeProfileHub         (large trades + volume profile)
//   5. tierFlowHub             (tier imbalance + divergensi)
//
// Modul 2 (wall) adalah SATU-SATUNYA yang butuh aliran event book & trade,
// jadi subscribing dilakukan di sini.

import { logger } from "../core/logger.js";
import { multiVenueOrderFlowHub } from "./multiVenueOrderFlowHub.js";
import { wallLifelines } from "./wallLifelines.js";
import { liquidationMapHub } from "./liquidationMapHub.js";
import { volumeProfileHub } from "./volumeProfileHub.js";
import { tierFlowHub } from "./tierFlowHub.js";
import { startVenueUniverse, stopVenueUniverse, refreshVenueUniverse } from "./venueUniverse.js";

let started = false;
const timers: NodeJS.Timeout[] = [];

/**
 * Start 5 modul mikrostruktur.
 *
 * Universe venue di-refresh DULU (dengan batas waktu 20 detik) supaya
 * subscribe per venue tidak meminta simbol yang tidak ada di bursa itu —
 * satu simbol invalid bisa membuat bursa menolak SELURUH subscribe.
 * Bila refresh gagal, daftar statis terverifikasi dipakai sebagai fallback.
 */
export async function startMicrostructureHubs(): Promise<void> {
  if (started) return;
  started = true;

  try {
    await Promise.race([
      refreshVenueUniverse(),
      new Promise<void>((r) => setTimeout(r, 20_000)),
    ]);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Venue universe refresh gagal — pakai daftar statis");
  }
  startVenueUniverse();

  multiVenueOrderFlowHub.start();

  // Wall lifelines: subdivide setiap update book, dan catat trade yang
  // melewati harga dinding (agar wall dihitung "eaten", bukan "pulled").
  multiVenueOrderFlowHub.onBook((book) => {
    wallLifelines.onBook(book);
  });
  multiVenueOrderFlowHub.onTrade((t) => {
    wallLifelines.onTrade(t.symbol, t.price, t.usd, t.t, t.venue);
  });
  // Dinding yang hilang tanpa trade melintas -> ditandai PULLED (spoof).
  timers.push(setInterval(() => wallLifelines.markPulled(), 3_000));

  volumeProfileHub.start();
  tierFlowHub.start();
  liquidationMapHub.start();

  logger.info("MICROSTRUCTURE_HUBS_STARTED");
}

export function stopMicrostructureHubs(): void {
  if (!started) return;
  started = false;
  for (const t of timers) clearInterval(t);
  timers.length = 0;
  multiVenueOrderFlowHub.stop();
  volumeProfileHub.stop();
  tierFlowHub.stop();
  liquidationMapHub.stop();
  stopVenueUniverse();
  logger.info("MICROSTRUCTURE_HUBS_STOPPED");
}

export function microstructureHubsStarted(): boolean {
  return started;
}
