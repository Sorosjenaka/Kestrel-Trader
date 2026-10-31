// apps/server/src/exec/reconciler.ts - Reconcile posisi saat boot + EventLog lengkap (NFR-04, NFR-12, US-13).
import { db } from "../core/db.js";
import { logger } from "../core/logger.js";
import { PositionRow, TradeRow } from "./positionSupervisor.js";

export type CriticalEventType =
  | "HOST_SWITCH"
  | "WS_FAILOVER"
  | "GUARD_HIT"
  | "DAILY_LOSS_GUARD_TRIGGERED"
  | "MAX_DRAWDOWN_GUARD_TRIGGERED"
  | "LEVERAGE_CHANGE"
  | "ARM"
  | "ARM_ENABLED"
  | "ARM_DISABLED"
  | "KILL"
  | "ORDER"
  | "ERROR"
  | "BOOT_RECONCILE"
  | "POSITION_RECONCILED"
  | "ORPHAN_POSITION_DETECTED"
  | "TP1_FILLED"
  | "POSITION_CLOSED";

export interface ExchangePositionSnapshot {
  symbol: string;
  positionAmt: number;
  entryPrice: number;
  markPrice: number;
}

export interface ReconcileExchangeClient {
  getOpenPositions(): Promise<ExchangePositionSnapshot[]>;
}

export interface ReconcileRepo {
  findOpenPositions(): Promise<PositionRow[]>;
  updatePosition(id: number, data: Partial<PositionRow>): Promise<void>;
  createTrade(trade: TradeRow): Promise<void>;
  logEvent(type: string, severity: string, payload: Record<string, unknown>): Promise<void>;
}

export interface ReconcileDetail {
  symbol: string;
  action: "MATCHED" | "CLOSED_OFFLINE" | "ORPHAN" | "SIMULATED_KEPT" | "ACCOUNTING_DEFERRED";
  note: string;
}

export interface ReconcileReport {
  timestamp: string;
  dbOpenCount: number;
  exchangeOpenCount: number;
  reconciledClosedCount: number;
  orphanCount: number;
  matchedCount: number;
  deferredCount: number;
  details: ReconcileDetail[];
}

export class PositionReconciler {
  private readonly repo: ReconcileRepo;
  private readonly exchange?: ReconcileExchangeClient;
  private readonly now: () => Date;

  constructor(options?: {
    repo?: ReconcileRepo;
    exchange?: ReconcileExchangeClient;
    now?: () => Date;
  }) {
    this.repo = options?.repo ?? prismaReconcileRepo;
    this.exchange = options?.exchange;
    this.now = options?.now ?? (() => new Date());
  }

  async reconcile(): Promise<ReconcileReport> {
    const nowDate = this.now();
    const dbPositions = await this.repo.findOpenPositions();
    const details: ReconcileDetail[] = [];

    let exchangePositions: ExchangePositionSnapshot[] = [];
    if (this.exchange) {
      try {
        exchangePositions = await this.exchange.getOpenPositions();
      } catch (err) {
        logger.error({ err }, "Gagal mengambil posisi exchange saat reconcile boot");
        await this.repo.logEvent("ERROR", "error", {
          context: "RECONCILE_EXCHANGE_FETCH",
          error: "EXCHANGE_SNAPSHOT_UNAVAILABLE",
        });
        // Unknown account state is never evidence of a flat account.
        throw new Error("RECONCILE_EXCHANGE_SNAPSHOT_UNAVAILABLE");
      }
    }

    const exchangeMap = new Map<string, ExchangePositionSnapshot>();
    for (const ep of exchangePositions) {
      if (Math.abs(ep.positionAmt) > 0) {
        exchangeMap.set(ep.symbol.toUpperCase(), ep);
      }
    }

    let reconciledClosedCount = 0;
    let matchedCount = 0;
    let orphanCount = 0;
    let deferredCount = 0;

    for (const pos of dbPositions) {
      const sym = pos.symbol.toUpperCase();

      // 11 Okt 2026 (insiden GO LIVE): posisi simulasi (PAPER/DEMO) TIDAK pernah ada di
      // exchange — reconcile exchange hanya boleh menyentuh posisi LIVE_*. Posisi
      // simulasi dikelola supervisor paper (SL/TP virtual mereka sendiri). Sebelum fix ini
      // seluruh buku PAPER ikut dianggap yatim dan dipaksa tutup di harga SL saat boot
      // LIVE (14 trade LOSS palsu -1R, RECONCILE_CLOSED_OFFLINE 06:58 CST).
      if (this.exchange && !String(pos.source ?? "").startsWith("LIVE_")) {
        details.push({
          symbol: sym,
          action: "SIMULATED_KEPT",
          note: "posisi simulasi (PAPER/DEMO) di luar cakupan reconcile exchange; supervisor paper yang mengelola",
        });
        continue;
      }

      if (this.exchange) {
        const live = exchangeMap.get(sym);
        if (!live) {
          // A flat snapshot proves no exposure, not the exit price/PnL. Keep
          // the ledger open until LivePositionWatcher obtains attributable fills.
          deferredCount++;
          await this.repo.logEvent("RECONCILE_ACCOUNTING_DEFERRED", "warn", {
            positionId: pos.id,
            symbol: pos.symbol,
            action: "ACCOUNTING_DEFERRED",
          });
          details.push({
            symbol: pos.symbol,
            action: "ACCOUNTING_DEFERRED",
            note: `Posisi ${pos.id} flat; menunggu bukti fill exit dari watcher, tanpa asumsi harga atau PnL`,
          });
        } else {
          matchedCount++;
          details.push({
            symbol: pos.symbol,
            action: "MATCHED",
            note: `Posisi ${pos.id} konsisten dengan exchange (qty: ${live.positionAmt})`,
          });
          exchangeMap.delete(sym);
        }
      } else {
        matchedCount++;
        details.push({
          symbol: pos.symbol,
          action: "SIMULATED_KEPT",
          note: `Posisi ${pos.id} tetap aktif dalam mode simulasi offline`,
        });
      }
    }
    if (this.exchange) {
      for (const [sym, ep] of exchangeMap.entries()) {
        orphanCount++;
        await this.repo.logEvent("ORPHAN_POSITION_DETECTED", "error", {
          symbol: sym,
          positionAmt: ep.positionAmt,
          entryPrice: ep.entryPrice,
          markPrice: ep.markPrice,
        });
        details.push({
          symbol: sym,
          action: "ORPHAN",
          note: `PERINGATAN: Posisi ${sym} aktif di exchange (qty: ${ep.positionAmt}) tanpa catatan DB`,
        });
      }
    }

    const report: ReconcileReport = {
      timestamp: nowDate.toISOString(),
      dbOpenCount: dbPositions.length,
      exchangeOpenCount: exchangePositions.length,
      reconciledClosedCount,
      orphanCount,
      matchedCount,
      deferredCount,
      details,
    };

    await this.repo.logEvent("BOOT_RECONCILE", "info", { ...report });

    logger.info(
      { dbOpen: dbPositions.length, closedOffline: reconciledClosedCount, matched: matchedCount, orphan: orphanCount },
      "Reconcile boot posisi selesai"
    );

    return report;
  }
}

export const prismaReconcileRepo: ReconcileRepo = {
  async findOpenPositions() {
    const rows = await db.position.findMany({
      where: { status: "OPEN" },
    });
    return rows as PositionRow[];
  },

  async updatePosition(id: number, data: Partial<PositionRow>) {
    await db.position.update({
      where: { id },
      data: {
        ...(data.status !== undefined ? { status: data.status } : {}),
        ...(data.closedAt !== undefined ? { closedAt: data.closedAt } : {}),
        ...(data.closeReason !== undefined ? { closeReason: data.closeReason } : {}),
        ...(data.pnlUsd !== undefined ? { pnlUsd: data.pnlUsd } : {}),
        ...(data.pnlR !== undefined ? { pnlR: data.pnlR } : {}),
      },
    });
  },

  async createTrade(data: TradeRow) {
    await db.trade.create({
      data: {
        positionId: data.positionId,
        symbol: data.symbol,
        mode: data.mode,
        side: data.side,
        riskUsd: data.riskUsd,
        // Budget NET ($) saat entry — denominator R ternormalisasi (opsi b, 29 Sep 2026).
        riskBudgetUsd: data.riskBudgetUsd ?? null,
        entryAvg: data.entryAvg,
        exitAvg: data.exitAvg,
        rMultiple: data.rMultiple,
        pnlUsd: data.pnlUsd,
        feeUsd: data.feeUsd,
        fundingUsd: data.fundingUsd,
        win: data.win,
        mfeR: data.mfeR,
        maeR: data.maeR,
        holdMinutes: data.holdMinutes,
        createdAt: data.createdAt ?? new Date(),
        entryAttrs: data.entryAttrs ?? null,
      },
    });
  },

  async logEvent(type: string, severity: string, payload: Record<string, unknown>) {
    await db.eventLog.create({
      data: {
        type,
        severity,
        payload: JSON.stringify(payload),
      },
    });
  },
};

export const defaultPositionReconciler = new PositionReconciler();

