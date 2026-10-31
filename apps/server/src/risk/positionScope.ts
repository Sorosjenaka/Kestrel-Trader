// apps/server/src/risk/positionScope.ts — scope posisi per mode eksekusi.
//
// 27 Okt 2026 (insiden go-live 07:15 WIB): posisi "OPEN" di DB tidak selalu
// berarti exposure nyata. Mode PAPER menyisakan posisi simulasi (source
// PAPER_AI) yang tidak ada di exchange sama sekali. Kalau gate slot menghitung
// posisi simulasi itu, posisi LIVE tidak pernah bisa masuk (insiden: 11 posisi
// PAPER_AI memblokir cap 3 posisi LIVE -> 0 order live selama 2 jam).
//
// Aturan (satu sumber kebenaran untuk semua pemanggil):
//   - PAPER: semua posisi OPEN kecuali DEMO (kapasitas 20, simulasi ikut makan).
//   - LIVE : HANYA posisi source="LIVE_*" yang ada di exchange dan memakan slot,
//            margin, notional likuidasi, dan PnL.
//
// Modul ini murni (tanpa I/O) supaya bisa diuji tanpa DB/exchange.
import type { Prisma } from "@prisma/client";

/** true bila mode eksekusi aktif adalah LIVE (baca env saat call, bukan saat import). */
export function isLiveExecution(): boolean {
  return String(process.env.BINANCE_EXECUTION_MODE ?? "PAPER").trim().toUpperCase() === "LIVE";
}

/**
 * Where-prisma untuk posisi OPEN yang benar-benar relevan untuk mode aktif.
 * `mode` opsional untuk memfilter lane (SCALP/SWING).
 */
export function executionScopedOpenWhere(mode?: "SCALP" | "SWING"): Prisma.PositionWhereInput {
  const where: Prisma.PositionWhereInput = { status: "OPEN" };
  if (isLiveExecution()) {
    // LIVE: hanya posisi LIVE_* (memang ada di exchange).
    where.source = { startsWith: "LIVE_" };
  } else {
    // PAPER: semua posisi non-DEMO (DEMO = pipeline uji, tidak dihitung).
    where.source = { not: "DEMO" };
  }
  if (mode) where.mode = mode;
  return where;
}

/**
 * Posisi OPEN pada SIMBOL tertentu apa pun sumbernya (paper maupun live).
 * Dipakai untuk mencegah satu simbol punya posisi simulasi DAN posisi live
 * bersamaan: supervisor internal (paper) dan SL/TP resting di exchange (live)
 * sama-sama it'd manage simbol itu -> risiko exit ganda.
 */
export function anyOpenSymbolWhere(symbol: string): Prisma.PositionWhereInput {
  return { status: "OPEN", symbol };
}

/**
 * Kapasitas slot lane SWING.
 * LIVE  : min(SWING_MAX_POSITIONS, LIVE_MAX_OPEN_POSITIONS) — cap keras live.
 * PAPER : min(MAX_OPEN_POSITIONS, SWING_MAX_POSITIONS) — kapasitas 20.
 */
export function swingSlotCap(input: {
  isLive: boolean;
  swingMaxPositions: number;
  liveMaxOpenPositions: number;
  paperMaxPositions: number;
}): number {
  if (input.isLive) {
    return Math.min(
      Math.max(1, input.swingMaxPositions),
      Math.max(1, input.liveMaxOpenPositions),
    );
  }
  return Math.min(
    Math.max(1, input.paperMaxPositions),
    Math.max(1, input.swingMaxPositions),
  );
}
