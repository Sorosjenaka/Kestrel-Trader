// apps/server/src/risk/lossCooldown.ts
// 11 Okt 2026 — guard cooldown pasca-LOSS global. Perintah operator (varian dipilih
// via clarify): "15 menit semua simbol (paling hemat trade)".
//
// Dasar data (audit 5 Whys 11 Okt 2026): 15/15 trade ber-kesalahan-eksekusi entry
// 0,2–14,3 menit setelah loss sebelumnya (median 10 menit). Gap same-symbol mereka
// 10,5–13,4 menit = baru lewat PostCloseReentryCooldownGuard (10 menit per-simbol),
// sisanya lolos dengan pindah simbol. Guard ini menambal keduanya: SEMUA simbol,
// khusus close ber-status LOSS.
//
// Relasi guard lain: PostCloseReentryCooldownGuard (10m, per-simbol, semua jenis close)
// tetap berlaku apa adanya — guard ini lapis TAMBAHAN 15 menit global untuk loss saja.
// Ini gerbang berbasis EVENT (kapan loss terjadi), BUKAN filter jam/sesi — aman dari
// veto permanen operator soal filter berbasis waktu.
//
// Desain (recipe deterministic-entry-guard): kelas murni tanpa I/O + Date.now
// injeksi-belakang, singleton, seed dari DB sekali (state in-memory hilang saat restart),
// record di titik close (supervisor + live watcher), gate di loop kandidat DAN seam
// pra-order (fail-closed). Rollback: LOSS_COOLDOWN_ENABLED=false di .env.
//
// Catatan keputusan: "slot wajib terisi" (29 Sep) tidak dilanggar — entry DITUNDA
// 15 menit, bukan diblokir permanen.
import { db } from "../core/db.js";
import { env } from "../core/env.js";
import { logger } from "../core/logger.js";

/** Keputusan operator 11 Okt 2026: "15 menit semua simbol (paling hemat trade)". */
export const LOSS_COOLDOWN_BLOCK_MIN = 15;
/** Perintah operator 13 Okt 2026 (pasca insiden GTCUSDT #3032, slippage spike +9%):
 *  close ber-reason SL membekukan entry SEMUA simbol 60 menit — sementara loss
 *  non-SL tetap 15 menit. Event-based, bukan filter jam/sesi. */
export const LOSS_COOLDOWN_SL_BLOCK_MIN = 60;
export const LOSS_COOLDOWN_GUARD_NAME = "LOSS_COOLDOWN";

export class LossCooldownGuard {
  private lastLossCloseAt: number | null = null;
  /** Anchor khusus close ber-reason SL (blokir lebih panjang, 60 menit). */
  private lastSlCloseAt: number | null = null;
  private readonly now: () => number;

  constructor(options?: { now?: () => number; initialLastLossAt?: number | null }) {
    this.now = options?.now ?? (() => Date.now());
    this.lastLossCloseAt = options?.initialLastLossAt ?? null;
  }

  /**
   * Catat hasil close trade. HANYA loss yang memulai cooldown; win tidak mengubah apa pun.
   * closeReason "SL" memulai blokir panjang (LOSS_COOLDOWN_SL_BLOCK_MIN) di ATAS blokir
   * standar 15 menit — perintah operator 13 Okt 2026.
   */
  recordClose(win: boolean, atMs?: number, closeReason?: string | null): void {
    if (win) return;
    const at = atMs ?? this.now();
    if (!Number.isFinite(at)) return;
    this.lastLossCloseAt = this.lastLossCloseAt === null ? at : Math.max(this.lastLossCloseAt, at);
    if (typeof closeReason === "string" && closeReason.toUpperCase() === "SL") {
      this.lastSlCloseAt = this.lastSlCloseAt === null ? at : Math.max(this.lastSlCloseAt, at);
    }
  }

  /** Seed dari riwayat DB (sekali di boot). Aturan sama dengan jalur live: loss terakhir. */
  seed(lastLossCloseAtMs: number | null): void {
    if (lastLossCloseAtMs === null || !Number.isFinite(lastLossCloseAtMs)) return;
    this.lastLossCloseAt = this.lastLossCloseAt === null
      ? lastLossCloseAtMs
      : Math.max(this.lastLossCloseAt, lastLossCloseAtMs);
  }

  /** Seed anchor SL (dari Position.closeReason="SL" terbaru). Tidak pernah memundurkan. */
  seedSl(lastSlCloseAtMs: number | null): void {
    if (lastSlCloseAtMs === null || !Number.isFinite(lastSlCloseAtMs)) return;
    this.lastSlCloseAt = this.lastSlCloseAt === null
      ? lastSlCloseAtMs
      : Math.max(this.lastSlCloseAt, lastSlCloseAtMs);
  }

  /** Sisa blokir efektif (ms): max(15m sejak loss terakhir, 60m sejak SL terakhir). */
  private effectiveBlockMs(nowMs: number): number {
    let block = 0;
    if (this.lastLossCloseAt !== null) {
      block = Math.max(block, LOSS_COOLDOWN_BLOCK_MIN * 60_000 - (nowMs - this.lastLossCloseAt));
    }
    if (this.lastSlCloseAt !== null) {
      block = Math.max(block, LOSS_COOLDOWN_SL_BLOCK_MIN * 60_000 - (nowMs - this.lastSlCloseAt));
    }
    return Math.max(0, block);
  }

  /** true = masih dalam masa blokir pasca-loss/SL -> entry (sisi/simbol apa pun) DITUNDA. */
  isBlocked(nowMs?: number): boolean {
    return this.effectiveBlockMs(nowMs ?? this.now()) > 0;
  }

  /** Sisa cooldown (ms) untuk observability; 0 = bebas. */
  remainingMs(nowMs?: number): number {
    return this.effectiveBlockMs(nowMs ?? this.now());
  }

  /** Menit sejak loss terakhir (observability/log); null bila belum ada loss. */
  sinceLossMin(nowMs?: number): number | null {
    if (this.lastLossCloseAt === null) return null;
    return ((nowMs ?? this.now()) - this.lastLossCloseAt) / 60_000;
  }

  clear(): void {
    this.lastLossCloseAt = null;
    this.lastSlCloseAt = null;
  }
}

export const lossCooldownGuard = new LossCooldownGuard();

/** Veto final pra-order (fail-closed). Throw = order TIDAK boleh dikirim. */
export function assertLossCooldownForEntry(): void {
  if (!env.LOSS_COOLDOWN_ENABLED) return;
  if (lossCooldownGuard.isBlocked()) {
    throw new Error(
      `${LOSS_COOLDOWN_GUARD_NAME}_BLOCKED_${Math.ceil(lossCooldownGuard.remainingMs() / 60_000)}MIN_LEFT`,
    );
  }
}

let seeded = false;
/**
 * Seed guard dari trade loss terakhir di DB — dipanggil sekali (boot / siklus awal).
 *
 * 27 Okt 2026 (insiden go-live 07:15 WIB): di mode LIVE, cooldown pasca-loss
 * hanya dihitung dari loss LIVE (source "LIVE_*"). Loss PAPER_AI adalah hasil
 * simulasi — tidak ada uang nyata yang hilang, jadi tidak boleh memblokir
 * entry live (blocked 15/60 menit SEMUA simbol termasuk live).
 * Sama seperti dailyGuard (getTodayTrades) dan tripwire loss.
 */
export async function seedLossCooldownOnce(): Promise<void> {
  if (seeded) return;
  seeded = true;
  try {
    const isLive = String(process.env.BINANCE_EXECUTION_MODE ?? "PAPER").trim().toUpperCase() === "LIVE";
    const lossSourceFilter = isLive
      ? { startsWith: "LIVE_" }
      : { not: "DEMO" };
    const last = await db.trade.findFirst({
      where: { win: false, source: lossSourceFilter },
      orderBy: { id: "desc" },
      select: { createdAt: true },
    });
    if (last?.createdAt) lossCooldownGuard.seed(new Date(last.createdAt).getTime());
    // 13 Okt 2026: seed anchor SL utk blokir panjang (closeReason="SL" terbaru).
    const lastSl = await db.position.findFirst({
      where: { closeReason: "SL", source: lossSourceFilter },
      orderBy: { id: "desc" },
      select: { closedAt: true },
    });
    if (lastSl?.closedAt) lossCooldownGuard.seedSl(new Date(lastSl.closedAt).getTime());
    logger.info(
      { isLive, lastLossCloseAt: last?.createdAt ?? null, lastSlCloseAt: lastSl?.closedAt ?? null },
      "LOSS_COOLDOWN_SEEDED",
    );
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, "LOSS_COOLDOWN_SEED_FAILED");
  }
}
