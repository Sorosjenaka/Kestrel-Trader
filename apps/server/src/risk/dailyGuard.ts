// apps/server/src/risk/dailyGuard.ts - Batas posisi + guard harian (FR-20, FR-21, US-07).
// 29 Sep 2026 — perintah operator: guard rugi harian (DAILY_STOP_USD) dan guard
// drawdown (AUTO_DISARM_DD_USD) DIHAPUS dari sistem. Kelas ini kini hanya
// menegakkan BATAS POSISI (MAX_OPEN_POSITIONS); PnL/drawdown tetap dilaporkan
// untuk observabilitas tetapi tidak lagi memblokir entry atau auto-disarm.
// Batas 20 adalah kapasitas maksimum, bukan target entry wajib.
import { db } from "../core/db.js";
import { env } from "../core/env.js";
import { logger } from "../core/logger.js";
import { afterPaperReset, getPaperResetAt } from "../core/paperSession.js";
import { buildLossStopReport } from "../agents/reportWriter.js";
import * as fs from "node:fs";
import * as path from "node:path";

// Satu sumber kebenaran batas posisi (server + UI).
// 10 Okt 2026 (jalur LIVE): mode LIVE dibatasi eksplisit oleh operator
// (fase test $3 = 1 posisi; fase $30 nanti = 3). PAPER tetap 20.
export const MAX_OPEN_POSITIONS =
  String(process.env.BINANCE_EXECUTION_MODE ?? "PAPER").trim().toUpperCase() === "LIVE"
    ? Math.max(1, Number(process.env.LIVE_MAX_OPEN_POSITIONS ?? 1))
    : 20;

/** Baris trade untuk guard. Field tambahan hanya dipakai laporan tripwire (opsional). */
export interface GuardTradeRow {
  pnlUsd: number;
  source?: string | null;
  symbol?: string;
  side?: string;
  rMultiple?: number | null;
  win?: boolean;
}

export interface GuardRepo {
  getOpenPositions(): Promise<Array<{ symbol: string; status: string }>>;
  getTodayTrades(sinceUtcMidnight: Date): Promise<Array<GuardTradeRow>>;
  getAllTrades(): Promise<Array<{ pnlUsd: number; createdAt: Date }>>;
  getArmSetting(): Promise<boolean | null>;
  setArmSetting(armed: boolean): Promise<void>;
  logEvent(type: string, severity: string, payload: Record<string, unknown>, dedupKey?: string): Promise<void>;
  claimEvent?(dedupKey: string): Promise<boolean>;
  // Realized TP1 posisi OPEN (opsional; mock lama tetap kompilasi).
  getOpenRealizedPnl?(since?: Date): Promise<number>;
}

export interface DailyGuardState {
  canTrade: boolean;
  armed: boolean;
  openPositionsCount: number;
  openSymbols: string[];
  dailyPnlUsd: number;
  cumulativePnlUsd: number;
  drawdownUsd: number;
  isDailyLossHit: boolean;
  isDrawdownHit: boolean;
  isLossTripwireHit: boolean;
  isMaxPositionsHit: boolean;
  reasons: string[];
}

/** The LIVE risk day is 07:00 Asia/Jakarta, represented as 00:00 UTC. */
export function getWibTradingWindowStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
}

export function getWibTradingDayKey(now = new Date()): string {
  return getWibTradingWindowStart(now).toISOString().slice(0, 10);
}

/** @deprecated Use getWibTradingWindowStart for the explicit 07:00 WIB contract. */
export function getUtcMidnight(now = new Date()): Date {
  return getWibTradingWindowStart(now);
}

export class DailyRiskGuard {
  private readonly repo: GuardRepo;
  private readonly maxPositions: number;
  private readonly dailyStopUsd: number;
  private readonly autoDisarmDdUsd: number;
  private readonly now: () => Date;
  private localArmed: boolean;

  private readonly disableDrawdownGuard: boolean;
  private readonly disableDailyStop: boolean;
  // 11 Okt 2026 — perintah operator: "kalau menghasilkan trade dan terus loss 1x langsung
  // berhenti trading dan kirimkan laporan nya. kalo hasil nya profit gas trade terus".
  // 12 Okt 2026 — perintah operator baru: "loss 2x stop berhenti" -> threshold = 2
  // (configurable LIVE_LOSS_TRIPWIRE_COUNT).
  // Tripwire khusus mode LIVE (PAPER tetap tanpa guard, keputusan operator 29 Sep 2026).
  private readonly lossTripwireLive: boolean;
  /** Jumlah loss LIVE yang memicu stop sejak ARM. Default 2 (perintah operator 12 Okt). */
  private readonly lossTripwireCount: number;
  private readonly onLossTripwire?: (info: {
    dayKey: string; dailyPnlUsd: number; losses: GuardTradeRow[]; todayCount: number;
  }) => void | Promise<void>;
  /** Jumlah loss LIVE saat sesi ARM ini dimulai — re-arm mengulang counter.
   * 13 Okt 2026: juga diulang saat ganti hari window (UTC midnight = 07:00 WIB). */
  private lossBaseline: number | null = null;
  /** Tanggal UTC (YYYY-MM-DD) terakhir saat baseline tripwire di-set. */
  private lossDayKey: string | null = null;

  constructor(options?: {
    repo?: GuardRepo;
    maxPositions?: number;
    dailyStopUsd?: number;
    autoDisarmDdUsd?: number;
    now?: () => Date;
    initialArmed?: boolean;
    disableDrawdownGuard?: boolean;
    disableDailyStop?: boolean;
    lossTripwireLive?: boolean;
    lossTripwireCount?: number;
    onLossTripwire?: (info: {
      dayKey: string; dailyPnlUsd: number; losses: GuardTradeRow[]; todayCount: number;
    }) => void | Promise<void>;
  }) {
    this.repo = options?.repo ?? prismaGuardRepo;
    this.maxPositions = options?.maxPositions ?? MAX_OPEN_POSITIONS;
    this.disableDailyStop = options?.disableDailyStop ?? false;
    this.disableDrawdownGuard = options?.disableDrawdownGuard ?? false;
    this.lossTripwireLive = options?.lossTripwireLive ?? false;
    this.lossTripwireCount = Math.max(1, Math.floor(
      options?.lossTripwireCount ?? env.LIVE_LOSS_TRIPWIRE_COUNT ?? 2));
    this.onLossTripwire = options?.onLossTripwire;
    // 29 Sep 2026 — perintah operator: guard RUGI HARIAN & guard DRAWDOWN DIHAPUS
    // dari sistem (bukan sekadar dimatikan). Tanpa opsi eksplisit, batas =
    // -Infinity sehingga TIDAK PERNAH terpicu. Opsi eksplisit tetap dihormati
    // supaya unit test kelas ini masih bisa menguji perilaku guard-nya.
    this.dailyStopUsd = this.disableDailyStop
      ? Number.NEGATIVE_INFINITY
      : (options?.dailyStopUsd ?? Number.NEGATIVE_INFINITY);
    this.autoDisarmDdUsd = this.disableDrawdownGuard
      ? Number.NEGATIVE_INFINITY
      : (options?.autoDisarmDdUsd ?? Number.NEGATIVE_INFINITY);
    this.now = options?.now ?? (() => new Date());
    this.localArmed = options?.initialArmed ?? env.ARM_DEFAULT;
  }

  isArmed(): boolean {
    return this.localArmed;
  }

  /**
   * 27 Okt 2026 (perintah operator: "hapus saja blocker Live nya jangan di
   * bypass") — HARD BLOCK ARM-in-LIVE DIHAPUS PERMANEN.
   *
   * Sebelumnya (15 Okt 2026) ada aturan "ARM tidak pernah boleh ON di live",
   * lalu 27 Okt 2026 diberi escape hatch ARM_LIVE_BYPASS=1. Sekarang escape
   * hatch itu TIDAK PERLU: interlock ARM dihapus sebagai dual-mode, sehingga
   * PAPER dan LIVE berperilaku identik dan tidak ada flag yang bisa "basi".
   *
   * Yang TETAP berlaku di mode LIVE (tidak ikut dihapus):
   *   - batas posisi LIVE_MAX_OPEN_POSITIONS (MAX_OPEN_POSITIONS di atas)
   *   - tripwire loss LIVE (LIVE_LOSS_TRIPWIRE_COUNT)
   *   - guard margin/equity di riskEngine + liveDepthGuard
   * Operator tetap satu-satunya-holder wewenang ARM; restart memulihkan
   * pilihan ARM yang tersimpan di DB persis seperti di mode PAPER.
   */

  /** Restore the operator's last ARM choice before any entry loop starts. */
  async restoreArmedState(): Promise<void> {
    const saved = await this.repo.getArmSetting();
    this.localArmed = saved ?? false;
  }

  async setArmed(armed: boolean, reason = "MANUAL"): Promise<void> {
    this.localArmed = armed;
    // 27 Okt 2026 (perintah operator): counter tripwire loss dihitung PER HARI
    // sejak 07:00 WIB — re-arm TIDAK menghapus hitungan hari ini (dulu reset per
    // sesi ARM). 6 SL/hari tetap 6 SL walau operator re-arm di tengah hari.
    await this.repo.setArmSetting(armed);
    await this.repo.logEvent(armed ? "ARM_ENABLED" : "ARM_DISABLED", armed ? "info" : "warn", {
      armed,
      reason,
      timestamp: this.now().toISOString(),
    });
  }

  async evaluateStatus(candidateSymbol?: string): Promise<DailyGuardState> {
    const nowDate = this.now();
    const openPositions = await this.repo.getOpenPositions();
    const openSymbols = openPositions.map((p) => p.symbol.toUpperCase());
    const openPositionsCount = openPositions.length;

    const windowStart = getWibTradingWindowStart(nowDate);
    const todayTrades = await this.repo.getTodayTrades(windowStart);
    // Realized TP1 posisi OPEN ikut masuk PnL (profit TP1 langsung tambah equity).
    const realizedToday = await this.repo.getOpenRealizedPnl?.(windowStart).catch(() => 0) ?? 0;
    const realizedTotal = await this.repo.getOpenRealizedPnl?.().catch(() => 0) ?? 0;
    // 11 Okt 2026 (GO LIVE): di mode LIVE, PnL harian (dasar cap $7) dihitung dari trade
    // LIVE saja — PnL PAPER peninggalan simulasi tidak boleh mematikan trading LIVE, dan
    // angkanya harus cocok dengan history Binance yang dicek operator.
    const todayRows = this.lossTripwireLive
      ? todayTrades.filter((t) => String(t.source ?? "").startsWith("LIVE"))
      : todayTrades;
    const dailyPnlUsd = Number(
      (todayRows.reduce((acc, t) => acc + t.pnlUsd, 0) + realizedToday).toFixed(4)
    );

    const allTrades = await this.repo.getAllTrades();
    let runningPnl = 0;
    let peakPnl = 0;
    let maxDrawdown = 0;

    for (const t of allTrades) {
      runningPnl += t.pnlUsd;
      if (runningPnl > peakPnl) {
        peakPnl = runningPnl;
      }
      const dd = runningPnl - peakPnl;
      if (dd < maxDrawdown) {
        maxDrawdown = dd;
      }
    }

    const cumulativePnlUsd = Number((runningPnl + realizedTotal).toFixed(4));
    const currentDrawdown = runningPnl - peakPnl;
    const worstDrawdownUsd = Number(Math.min(currentDrawdown, maxDrawdown).toFixed(4));

    const isDailyLossHit = dailyPnlUsd <= this.dailyStopUsd;
    // Guard drawdown dapat dinonaktifkan sementara atas perintah operator (DD tetap dilaporkan).
    const isDrawdownHit = this.disableDrawdownGuard
      ? false
      : worstDrawdownUsd <= this.autoDisarmDdUsd || cumulativePnlUsd <= this.autoDisarmDdUsd;
    const isMaxPositionsHit = openPositionsCount >= this.maxPositions;

    // 12 Okt 2026 — tripwire loss LIVE: N x loss (default 2, perintah operator
    // "loss 2x stop berhenti") = berhenti + laporan. Hanya trade ber-sumber LIVE
    // yang dihitung (trade PAPER tidak memicu).
    // 13 Okt 2026 — perintah operator: window harian reset 07:00 WIB (= UTC
    // midnight). Baseline tripwire ikut window harian.
    // 27 Okt 2026 (perintah operator "6X SL perhari dihitung dari jam 7 pagi"):
    // hitungan loss = SEMUA loss LIVE dalam window hari ini (sejak 07:00 WIB),
    // termasuk yang terjadi sebelum restart/ARM — baseline selalu 0 per hari.
    const liveLossRows = todayTrades.filter(
      (t) => t.pnlUsd < 0 && String(t.source ?? "").startsWith("LIVE"),
    );
    const dayKey = getWibTradingDayKey(nowDate);
    if (this.lossDayKey !== dayKey) {
      this.lossDayKey = dayKey;
      this.lossBaseline = null;
    }
    if (this.lossBaseline === null) this.lossBaseline = 0;
    const lossesSinceArm = liveLossRows.length - (this.lossBaseline ?? 0);
    const isLossTripwireHit = this.lossTripwireLive && lossesSinceArm >= this.lossTripwireCount;
    const tripwireLosses: GuardTradeRow[] = isLossTripwireHit
      ? liveLossRows.slice(this.lossBaseline ?? 0)
      : [];

    const reasons: string[] = [];
    if (isDailyLossHit) {
      reasons.push(`DAILY_LOSS_GUARD_HIT: Daily PnL $${dailyPnlUsd} <= limit $${this.dailyStopUsd}`);
    }
    if (isDrawdownHit) {
      reasons.push(`DRAWDOWN_GUARD_HIT: Drawdown $${worstDrawdownUsd} <= limit $${this.autoDisarmDdUsd}`);
    }
    if (isLossTripwireHit) {
      reasons.push(`LIVE_LOSS_TRIPWIRE: ${tripwireLosses.length}x loss LIVE sejak ARM (batas ${this.lossTripwireCount}) — trading dihentikan + laporan (perintah operator 12 Okt 2026)`);
    }
    if (isMaxPositionsHit) {
      reasons.push(`MAX_POSITIONS_REACHED: ${openPositionsCount}/${this.maxPositions} open positions`);
    }
    if (candidateSymbol && openSymbols.includes(candidateSymbol.toUpperCase())) {
      reasons.push(`SYMBOL_ALREADY_OPEN: Position for ${candidateSymbol.toUpperCase()} already active`);
    }

    if ((isDailyLossHit || isDrawdownHit || isLossTripwireHit) && this.localArmed) {
      logger.warn({ isDailyLossHit, isDrawdownHit, dailyPnlUsd, worstDrawdownUsd }, "Auto-disarm triggered by risk guard");
      this.localArmed = false;
      await this.repo.setArmSetting(false);

      if (isDailyLossHit) {
        await this.repo.logEvent("DAILY_LOSS_GUARD_TRIGGERED", "error", {
          dailyPnlUsd,
          worstDrawdownUsd,
          reasons,
          action: "AUTO_DISARM",
        });
      }
      if (isDrawdownHit) {
        await this.repo.logEvent("MAX_DRAWDOWN_GUARD_TRIGGERED", "error", {
          dailyPnlUsd,
          worstDrawdownUsd,
          reasons,
          action: "AUTO_DISARM",
        });
      }
      if (isLossTripwireHit) {
        const dedupKey = `LIVE_LOSS_TRIPWIRE:${dayKey}`;
        const firstTrigger = this.repo.claimEvent ? await this.repo.claimEvent(dedupKey) : true;
        if (firstTrigger) {
          await this.repo.logEvent("LIVE_LOSS_TRIPWIRE_TRIGGERED", "error", {
            losses: tripwireLosses.length,
            dailyPnlUsd,
            action: "AUTO_DISARM_AND_REPORT",
            rule: `${this.lossTripwireCount} loss LIVE per window 07:00 WIB`,
            windowStart: windowStart.toISOString(),
            windowEnd: new Date(windowStart.getTime() + 86_400_000).toISOString(),
          });
          // Laporan best-effort: gagal menulis file tidak boleh menggagalkan guard.
          try {
            await this.onLossTripwire?.({
              dayKey,
              dailyPnlUsd,
              losses: tripwireLosses,
              todayCount: todayTrades.length,
            });
          } catch (err) {
            logger.warn({ err }, "LOSS_TRIPWIRE_REPORT_FAILED");
          }
        }
      }
    }

    const canTrade = !isDailyLossHit && !isDrawdownHit && !isLossTripwireHit && !isMaxPositionsHit && reasons.length === 0;

    return {
      canTrade,
      armed: this.localArmed,
      openPositionsCount,
      openSymbols,
      dailyPnlUsd,
      cumulativePnlUsd,
      drawdownUsd: worstDrawdownUsd,
      isDailyLossHit,
      isDrawdownHit,
      isLossTripwireHit,
      isMaxPositionsHit,
      reasons,
    };
  }
  async canOpenPosition(candidateSymbol: string): Promise<{ allowed: boolean; reason?: string }> {
    const status = await this.evaluateStatus(candidateSymbol);
    if (!status.canTrade) {
      return { allowed: false, reason: status.reasons.join(" | ") };
    }
    return { allowed: true };
  }
}

export const prismaGuardRepo: GuardRepo = {
  async getOpenPositions() {
    // 11 Okt 2026 (GO LIVE): di mode LIVE, guard menghitung posisi LIVE saja — posisi PAPER
    // peninggalan simulasi tidak memakan slot 1-posisi uji coba.
    const isLive = String(process.env.BINANCE_EXECUTION_MODE ?? "PAPER").trim().toUpperCase() === "LIVE";
    const rows = await db.position.findMany({
      // Data DEMO (pipeline uji) TIDAK dihitung di guard/equity (T-5.16).
      where: isLive
        ? { status: "OPEN", source: { startsWith: "LIVE_" } }
        : { status: "OPEN", source: { not: "DEMO" } },
      select: { symbol: true, status: true },
    });
    return rows;
  },

  async getTodayTrades(sinceUtcMidnight: Date) {
    const resetAt = await getPaperResetAt();
    const since = resetAt && resetAt > sinceUtcMidnight ? resetAt : sinceUtcMidnight;
    const rows = await db.trade.findMany({
      where: { createdAt: { gte: since }, source: { not: "DEMO" } },
      select: { pnlUsd: true, source: true, symbol: true, side: true, rMultiple: true, win: true },
    });
    return rows;
  },

  async getAllTrades() {
    const resetAt = await getPaperResetAt();
    const rows = await db.trade.findMany({
      where: { source: { not: "DEMO" }, ...afterPaperReset(resetAt) },
      orderBy: { createdAt: "asc" },
      select: { pnlUsd: true, createdAt: true },
    });
    return rows;
  },

  async getArmSetting() {
    const row = await db.setting.findUnique({
      where: { key: "arm_status" },
    });
    if (!row) return null;
    return row.value === "true";
  },

  async setArmSetting(armed: boolean) {
    // 27 Okt 2026 (perintah operator: "hapus saja blocker Live nya jangan di
    // bypass") — hard block yang TIDAK boleh persist "true" di mode LIVE juga
    // DIHAPUS. Sebelumnya: `persist = armed && live ? false : armed`, sehingga
    // ARM yang dinyalakan operator di LIVE TIDAK pernah tersimpan -> setiap
    // restart service mengembalikan ARM=false dan bot berhenti entry (liveReady
    // ikut false). Sekarang ARM identik di PAPER dan LIVE, dan pilihan
    // operator pulih persis seperti di mode PAPER.
    await db.setting.upsert({
      where: { key: "arm_status" },
      update: { value: String(armed) },
      create: { key: "arm_status", value: String(armed) },
    });
  },

  async claimEvent(dedupKey: string) {
    try {
      await db.eventLog.create({
        data: {
          type: "EVENT_CLAIM",
          severity: "info",
          payload: JSON.stringify({ dedupKey }),
          dedupKey,
        },
      });
      return true;
    } catch {
      return false;
    }
  },

  async logEvent(type: string, severity: string, payload: Record<string, unknown>, dedupKey?: string) {
    await db.eventLog.create({
      data: {
        type,
        severity,
        payload: JSON.stringify(payload),
        dedupKey: dedupKey ?? null,
      },
    });
  },

  async getOpenRealizedPnl(since?: Date) {
    const resetAt = await getPaperResetAt();
    const effectiveSince = since && resetAt ? new Date(Math.max(since.getTime(), resetAt.getTime())) : since ?? resetAt;
    const agg = await db.position.aggregate({
      _sum: { realizedPnlUsd: true },
      where: {
        status: "OPEN",
        source: { not: "DEMO" },
        ...(effectiveSince ? { tp1FilledAt: { gte: effectiveSince } } : {}),
      },
    });
    return Number(agg._sum.realizedPnlUsd ?? 0);
  },
};

// 29 Sep 2026 — perintah operator: guard DRAWDOWN dan guard RUGI HARIAN
// (DAILY_STOP_USD) keduanya DIHAPUS. Angka PnL harian/kumulatif/drawdown tetap
// dihitung dan dilaporkan di /api/guard/status untuk observabilitas, tetapi
// TIDAK ada lagi auto-disarm maupun blokir entry dari guard ini.
// 10 Okt 2026 (jalur LIVE): bila BINANCE_EXECUTION_MODE=LIVE dan
// LIVE_DAILY_DD_CAP_USD > 0, guard rugi harian DIAKTIFKAN KEMBALI khusus LIVE
// sebagai cap drawdown harian (disarm saat dailyPnl <= -cap). Ini satu-satunya
// mode yang menghidupkan guard ini; PAPER tetap tanpa guard sesuai perintah 29 Sep.
// 11 Okt 2026 — perintah operator: cap $7 dengan TOLERANSI 1 loss terakhir
// ("misal 6.2$ masih boleh 1x trade loss lagi, gw masih toleransi"): guard memblokir
// ENTRY baru saat dailyPnl <= -7, sementara trade yang sedang berjalan tetap boleh
// mendarat (loss maks $1.2) sehingga DD bisa mampir ke -7.4 dst tanpa aksi tambahan.
const _liveDdCap = Number(process.env.LIVE_DAILY_DD_CAP_USD ?? 0);
const _isLive = String(process.env.BINANCE_EXECUTION_MODE ?? "PAPER").trim().toUpperCase() === "LIVE";
export const defaultDailyRiskGuard = new DailyRiskGuard({
  // REVISI 15 Okt 2026 (perintah operator): guard rugi harian & drawdown untuk
  // PAPER/BACKTEST DIMATIKAN lagi ("untuk paper atau backtest ga usah pakai
  // drawdown harian") — revisi atas Tahap 6 pagi ini. LIVE tetap jalurnya
  // sendiri (LIVE_DAILY_DD_CAP_USD). PnL/drawdown tetap dilaporkan di status,
  // tanpa blokir.
  disableDailyStop: !(_isLive && _liveDdCap > 0),
  dailyStopUsd: _isLive && _liveDdCap > 0
    ? -_liveDdCap
    : Number.NEGATIVE_INFINITY,
  disableDrawdownGuard: !(_isLive && _liveDdCap > 0),
  autoDisarmDdUsd: _isLive && _liveDdCap > 0
    ? -_liveDdCap
    : Number.NEGATIVE_INFINITY,
  maxPositions: MAX_OPEN_POSITIONS,
  // Tripwire "N x loss = stop + laporan" (operator 11 Okt: 1x; 12 Okt: "loss 2x stop
  // berhenti" -> default 2 via LIVE_LOSS_TRIPWIRE_COUNT) — khusus LIVE.
  lossTripwireLive: _isLive,
  lossTripwireCount: Number(process.env.LIVE_LOSS_TRIPWIRE_COUNT ?? 2),
  onLossTripwire: async (info) => {
    const reportDir = path.join(process.cwd(), "data", "reports");
    fs.mkdirSync(reportDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const reportPath = path.join(reportDir, `loss-stop-${stamp}.md`);
    fs.writeFileSync(reportPath, buildLossStopReport({
      nowIso: new Date().toISOString(),
      trigger: "LIVE_LOSS_TRIPWIRE",
      dailyPnlUsd: info.dailyPnlUsd,
      losses: info.losses,
      todayCount: info.todayCount,
    }), "utf8");
    logger.warn({ reportPath, losses: info.losses.length }, "LOSS_TRIPWIRE_REPORT_WRITTEN");
  },
});

