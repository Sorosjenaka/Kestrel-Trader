// apps/server/src/exec/orderExecutor.ts - Executor Idempoten + Verifikasi Fill WS/REST (FR-22, NFR-02).
import { db } from "../core/db.js";
import { env } from "../core/env.js";
import { binanceFuturesClient } from "../markets/binanceFuturesClient.js";
import { estimateFillFeeUsd, isMakerOrderType } from "../config/costs.js";
import { calculateDynamicSlippage } from "../backtest/validation/slippageModel.js";
import { canTransition } from "./orderStateMachine.js";
import { logger } from "../core/logger.js";

export type OrderType = "LIMIT" | "MARKET" | "STOP_MARKET" | "TAKE_PROFIT_MARKET";
export type OrderSide = "BUY" | "SELL";
export type OrderStatus = "NEW" | "PARTIAL" | "FILLED" | "CANCELED" | "REJECTED" | "EXPIRED";

export interface OrderRequest {
  clientOrderId?: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  price: number;
  qty: number;
  reduceOnly?: boolean;
  positionId?: number;
  /** T-13 (19 Okt 2026): TIF live. GTX = post-only (maker), ditolak bila crossing. */
  timeInForce?: "GTC" | "IOC" | "FOK" | "GTX";
  /** Jendela bukti sentuhan harga utk fill paper LIMIT (TAHAP 5 audit 15 Okt).
   *  Default = saat order dibuat. Exit TP adalah bracket yang seharusnya resting
   *  sejak posisi dibuka — pemanggil (positionSupervisor) memberi openedAt,
   *  sehingga order exit yang ditempatkan TELAT tetap terisi oleh sentuhan kline
   *  yang lebih awal (fix lanjutan #3177, 16 Okt 2026). */
  touchSinceMs?: number;
}

export interface ExecutionResult {
  clientOrderId: string;
  binanceOrderId: string | null;
  symbol: string;
  status: OrderStatus;
  fillPrice: number | null;
  filledQty: number;
  feeUsd: number;
  ackLatencyMs: number;
  fillLatencyMs: number;
  isDuplicate: boolean;
  simulated: boolean;
  error?: string;
  feeEstimated?: boolean;
}

export interface OrderCancellationResult {
  /** Only a terminal query (or a local paper cancellation) confirms settlement. */
  confirmed: boolean;
  execution?: ExecutionResult;
  reason?: string;
}

/** Slip di fill paper non-LIMIT (MARKET / STOP_MARKET / TAKE_PROFIT_MARKET).
 *  Mengembalikan slippage dalam basis points (bps) — biaya likuiditas taker.
 *  Opt-in (default undefined = tanpa slip) agar unit test existing tetap hijau. */
export type SlippageEstimator = (input: { price: number; qty: number; side: OrderSide; type: OrderType }) => number;

/** Estimator produksi (T0.2): membungkus calculateDynamicSlippage.
 *  Tanpa feed ATR/volume, model menurun anggun (volFactor 1.0, participation 0.1
 *  -> ~base×1.02). baseSlippageBps default 2 = baseline spread cost Binance USDT-M. */
export function paperFillSlippageBps(input: { price: number; qty: number; baseSlippageBps?: number }): number {
  return calculateDynamicSlippage({
    baseSlippageBps: input.baseSlippageBps ?? 2,
    atrCurrent: 0,
    atrAverage24h: 0,
    orderNotionalUsd: input.price * input.qty,
    barVolumeUsd: 0,
  }, 0.2);
}

export interface OrderExecRow {
  id?: number;
  positionId?: number | null;
  clientOrderId: string;
  binanceOrderId?: string | null;
  symbol: string;
  type: string;
  side: string;
  price: number;
  qty: number;
  reduceOnly: boolean;
  status: string;
  fillPrice?: number | null;
  feeUsd?: number | null;
  createdAt?: Date;
  filledAt?: Date | null;
  filledQty?: number | null;
  feeEstimated?: boolean;
  simulated?: boolean;
}

export interface OrderExecRepo {
  findByClientOrderId(clientOrderId: string): Promise<OrderExecRow | null>;
  create(order: OrderExecRow): Promise<OrderExecRow>;
  updateStatus(clientOrderId: string, status: OrderStatus, fillPrice?: number, feeUsd?: number, filledAt?: Date, execution?: Partial<OrderExecRow>): Promise<OrderExecRow>;
}

export interface ExchangeClient {
  postOrder(req: OrderRequest & { clientOrderId: string }): Promise<{
    orderId: string | number;
    status: string;
    avgPrice?: number | string;
    executedQty?: number | string;
    feeUsd?: number;
  }>;
  queryOrder(symbol: string, clientOrderId: string): Promise<{
    orderId: string | number;
    status: string;
    avgPrice?: number | string;
    executedQty?: number | string;
    feeUsd?: number;
  }>;
  /** Opsional: batalkan entry yang belum terisi (LIMIT timeout). */
  cancelOrder?(symbol: string, clientOrderId: string): Promise<{ status?: string }>;
}
export function generateClientOrderId(symbol: string, now = Date.now()): string {
  const cleanSym = symbol.replace(/[^A-Za-z0-9]/g, "").slice(0, 6).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `AT_${cleanSym}_${now}_${rand}`.slice(0, 36);
}


export class OrderExecutor {
  private readonly repo: OrderExecRepo;
  private readonly exchange?: ExchangeClient;
  private readonly isArmed: () => boolean;
  private readonly now: () => number;
  private readonly paperAllowed: boolean;
  private readonly inFlight = new Map<string, Promise<ExecutionResult>>();
  private readonly paperTouchVerifier?: (symbol: string, price: number, side: string, sinceMs: number) => Promise<boolean>;
  private readonly slippageEstimator?: SlippageEstimator;

  constructor(options?: { repo?: OrderExecRepo; exchange?: ExchangeClient; isArmed?: () => boolean; now?: () => number; paperAllowed?: boolean;
    /** TAHAP 5 audit (15 Okt 2026): verifikasi sentuhan harga utk fill paper —
     *  LIMIT paper hanya fill bila kline membuktikan harga req.price tersentuh. */
    paperTouchVerifier?: (symbol: string, price: number, side: string, sinceMs: number) => Promise<boolean>;
    /** T0.2 (18 Okt 2026): slip dinamis utk fill paper non-LIMIT. Opt-in. */
    slippageEstimator?: SlippageEstimator; }) {
    this.repo = options?.repo ?? prismaOrderExecRepo;
    this.exchange = options?.exchange;
    this.isArmed = options?.isArmed ?? (() => false);
    this.now = options?.now ?? Date.now;
    this.paperAllowed = options?.paperAllowed ?? true;
    this.paperTouchVerifier = options?.paperTouchVerifier;
    this.slippageEstimator = options?.slippageEstimator;
  }

  async executeOrder(req: OrderRequest): Promise<ExecutionResult> {
    if (!Number.isFinite(req.qty) || req.qty <= 0 || !Number.isFinite(req.price) || req.price <= 0) {
      throw new Error("Order requires finite positive quantity and price");
    }
    const clientOrderId = req.clientOrderId || generateClientOrderId(req.symbol, this.now());
    const running = this.inFlight.get(clientOrderId);
    if (running) return { ...await running, isDuplicate: true };
    const task = this.executeOnce({ ...req, clientOrderId });
    this.inFlight.set(clientOrderId, task);
    try { return await task; } finally { this.inFlight.delete(clientOrderId); }
  }

  private async executeOnce(req: OrderRequest & { clientOrderId: string }): Promise<ExecutionResult> {
    if (!this.exchange && !this.paperAllowed) throw new Error("LIVE_ORDER_MANAGER_NOT_CONNECTED");
    // Disarming blocks new exposure, but must not block a reduce-only exit.
    if (this.exchange && !this.isArmed() && !req.reduceOnly) throw new Error("ARM_REQUIRED");
    const start = this.now();
    const existing = await this.repo.findByClientOrderId(req.clientOrderId);
    if (existing) {
      // A retry with a reused id must never become a different exchange order.
      if (existing.symbol !== req.symbol || existing.side !== req.side || existing.type !== req.type ||
          existing.qty !== req.qty || (req.type === "LIMIT" && existing.price !== req.price) ||
          existing.reduceOnly !== (req.reduceOnly ?? false)) {
        throw new Error("clientOrderId already belongs to a different order");
      }
      if (this.exchange && ["NEW", "PARTIAL"].includes(existing.status)) {
        const query = await this.exchange.queryOrder(existing.symbol, existing.clientOrderId);
        return { ...await this.recordResponse(existing, query, start), isDuplicate: true };
      }
      // 16 Okt 2026 (fix lanjutan #3177): paper LIMIT yang resting (NEW) tidak
      // boleh menggantung selamanya. Retry id yang sama = kesempatan fill ulang:
      // bila kline membuktikan level tersentuh sejak jendela touch (touchSinceMs
      // / createdAt order), baris YANG SAMA dipromosikan FILLED di harga level —
      // bukan order baru, bukan debit duplikat.
      if (!this.exchange && existing.simulated === true && existing.status === "NEW"
          && existing.type === "LIMIT" && this.paperTouchVerifier) {
        const since = req.touchSinceMs ?? existing.createdAt?.getTime() ?? start;
        const touched = await this.paperTouchVerifier(req.symbol, existing.price, existing.side, since).catch(() => false);
        if (touched) {
          // Fee penuh (18 Okt 2026): fill paper LIMIT = maker. Menggantikan
          // "Perintah Operator: Hapus Fee & Slippage" (dicabut).
          const fillFee = estimateFillFeeUsd({ qty: existing.qty, price: existing.price, isMaker: true });
          const filled = await this.repo.updateStatus(req.clientOrderId, "FILLED", existing.price, fillFee, new Date(this.now()),
            { filledQty: existing.qty, feeEstimated: true, simulated: true });
          return this.toResult(filled, this.now() - start, true);
        }
      }
      return this.toResult(existing, 0, true);
    }
    const simulated = !this.exchange;
    const base: OrderExecRow = {
      clientOrderId: req.clientOrderId, binanceOrderId: null, symbol: req.symbol,
      type: req.type, side: req.side, price: req.price, qty: req.qty,
      reduceOnly: req.reduceOnly ?? false, positionId: req.positionId ?? null,
      status: "NEW", filledQty: 0, feeEstimated: true, simulated, createdAt: new Date(start),
    };
    if (simulated) {
      // TAHAP 5 audit (15 Okt 2026): fill paper LIMIT wajib bukti sentuhan harga.
      // Tanpa verifier (unit test) perilaku lama: langsung FILLED.
      if (this.paperTouchVerifier && req.type === "LIMIT") {
        const touched = await this.paperTouchVerifier(req.symbol, req.price, req.side, req.touchSinceMs ?? start).catch(() => false);
        if (!touched) {
          // Harga belum disentuh sejak order dibuat: order resting (NEW), bukan fill.
          const row = await this.repo.create({ ...base, binanceOrderId: `SIM_${req.clientOrderId}`, status: "NEW" });
          return this.toResult(row, this.now() - start, false);
        }
      }
      // Fee penuh (18 Okt 2026): entry taker / limit maker. Menggantikan
      // "Perintah Operator: Hapus Fee & Slippage. Paper trading tanpa biaya" (dicabut).
      // T0.2 (18 Okt 2026): slip dinamis utk fill non-LIMIT (market/stop = taker).
      // LIMIT tetap fill di harga level (maker, tanpa slip). BUY slip naik, SELL slip turun.
      const fillPrice = this.applyPaperSlippage(req);
      const fillFee = estimateFillFeeUsd({ qty: req.qty, price: fillPrice, isMaker: isMakerOrderType(req.type) });
      const row = await this.repo.create({ ...base, binanceOrderId: `SIM_${req.clientOrderId}`,
        status: "FILLED", fillPrice, filledQty: req.qty,
        feeUsd: fillFee, filledAt: new Date(this.now()) });
      return this.toResult(row, this.now() - start, false);
    }
    await this.repo.create(base);
    // Persist NEW before submitting. On transport uncertainty, retry queries this id;
    // it must not submit another market order.
    const response = await this.exchange!.postOrder(req);
    return this.recordResponse(base, response, start);
  }

  /** T0.2 (18 Okt 2026): slip fill paper non-LIMIT (market/stop) secara adverse.
   *  BUY slip naik (bayar lebih), SELL slip turun (terima lebih sedikit). LIMIT
   *  tidak slip (fill di harga level, maker). Tanpa estimator -> tanpa slip. */
  private applyPaperSlippage(req: { price: number; qty: number; side: OrderSide; type: OrderType }): number {
    if (req.type === "LIMIT" || !this.slippageEstimator) return req.price;
    const bps = this.slippageEstimator(req);
    if (!Number.isFinite(bps) || bps <= 0) return req.price;
    const sign = req.side === "BUY" ? 1 : -1;
    return Number((req.price * (1 + (sign * bps) / 10000)).toFixed(8));
  }

  private async recordResponse(row: OrderExecRow, response: Awaited<ReturnType<ExchangeClient["queryOrder"]>>, start: number): Promise<ExecutionResult> {
    const statuses: Record<string, OrderStatus> = { NEW: "NEW", FILLED: "FILLED", PARTIALLY_FILLED: "PARTIAL", PARTIAL: "PARTIAL", CANCELED: "CANCELED", REJECTED: "REJECTED", EXPIRED: "EXPIRED", EXPIRED_IN_MATCH: "EXPIRED" };
    const status = statuses[response.status];
    if (!status) throw new Error("EXCHANGE_ORDER_STATUS_UNKNOWN");
    const reportedQty = Number(response.executedQty);
    const filledQty = Number.isFinite(reportedQty) && reportedQty >= 0 ? Math.min(reportedQty, row.qty) : Number(row.filledQty ?? 0);
    const reportedPrice = Number(response.avgPrice);
    const fillPrice = reportedPrice > 0 && Number.isFinite(reportedPrice) ? reportedPrice : row.fillPrice ?? null;
    // Fee penuh (18 Okt 2026) — menggantikan "Perintah Operator: Hapus Fee &
    // Slippage. Selalu nol di paper/live sim" (dicabut). Nomor terbaik dipakai:
    // fee yang dilaporkan exchange bila ada, selain itu estimasi dari notional
    // (tipe order menentukan maker/taker). Tetap PROVISIONAL (feeEstimated=true)
    // sampai backfill userTrades/getIncome di liveRuntime mengonfirmasi.
    const reportedFee = Number(response.feeUsd);
    const feeUsd = Number.isFinite(reportedFee) && reportedFee >= 0
      ? reportedFee
      : estimateFillFeeUsd({ qty: filledQty, price: fillPrice ?? row.price, isMaker: isMakerOrderType(row.type) });
    const feeEstimated = true;
    const patch = { binanceOrderId: String(response.orderId), filledQty, feeEstimated, simulated: false };
    await this.repo.updateStatus(row.clientOrderId, status, fillPrice ?? undefined, feeUsd,
      status === "FILLED" ? new Date(this.now()) : undefined, patch);
    return this.toResult({ ...row, ...patch, status, fillPrice, feeUsd }, this.now() - start, false);
  }

  async verifyFill(symbol: string, clientOrderId: string, timeoutMs = 2000, pollIntervalMs = 50): Promise<ExecutionResult> {
    const start = this.now();
    let row = await this.repo.findByClientOrderId(clientOrderId);
    if (!row) throw new Error(`Order ${clientOrderId} tidak ditemukan`);
    let result = this.toResult(row, 0, false);
    // TAHAP 5: paper LIMIT resting (NEW) — fill hanya setelah harga tersentuh.
    if (!this.exchange && row.simulated === true && row.status === "NEW" && this.paperTouchVerifier) {
      const deadline = Date.now() + Math.max(0, timeoutMs);
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, Math.max(1, pollIntervalMs)));
        const touched = await this.paperTouchVerifier(symbol, row.price, row.side, row.createdAt?.getTime() ?? Date.now()).catch(() => false);
        if (touched) {
          // Fee penuh (18 Okt 2026): fill paper LIMIT = maker.
          const touchFee = estimateFillFeeUsd({ qty: row.qty, price: row.price, isMaker: true });
          return await this.repo.updateStatus(clientOrderId, "FILLED", row.price, touchFee, new Date(this.now()),
            { status: "FILLED", fillPrice: row.price, filledQty: row.qty, feeUsd: touchFee, feeEstimated: true, simulated: true }).then((r2) => this.toResult(r2, this.now() - start, false));
        }
      }
      return result; // tetap NEW — pemanggil (plannedEntry) akan membatalkan bersih
    }
    if (!this.exchange || !["NEW", "PARTIAL"].includes(row.status)) return result;
    // Bound by wall time too, so an injected frozen clock cannot loop forever.
    const deadline = Date.now() + Math.max(0, timeoutMs);
    do {
      try {
        result = await this.recordResponse(row, await this.exchange.queryOrder(symbol, clientOrderId), start);
        if (!["NEW", "PARTIAL"].includes(result.status)) return result;
        row = { ...row, status: result.status, fillPrice: result.fillPrice, filledQty: result.filledQty, feeUsd: result.feeUsd };
      } catch { /* Unknown execution remains unknown; never invent a fill. */ }
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, Math.max(1, pollIntervalMs)));
    } while (Date.now() < deadline);
    return result;
  }

  private toResult(row: OrderExecRow, elapsed: number, isDuplicate: boolean): ExecutionResult {
    const simulated = row.simulated === true || row.binanceOrderId?.startsWith("SIM_") === true;
    return { clientOrderId: row.clientOrderId, binanceOrderId: row.binanceOrderId ?? null,
      symbol: row.symbol, status: row.status as OrderStatus, fillPrice: row.fillPrice ?? null,
      filledQty: row.filledQty ?? (simulated && row.status === "FILLED" ? row.qty : 0),
      feeUsd: row.feeUsd ?? 0, feeEstimated: row.feeEstimated ?? true,
      ackLatencyMs: elapsed, fillLatencyMs: elapsed, isDuplicate, simulated };
  }

  /** Settle an entry or exit before removing guards or sending a competing order.
   * Transport errors never establish cancellation; the final query includes any
   * fills that raced the cancellation request. Unknown orders remain unknown. */
  async cancelEntry(symbol: string, clientOrderId: string): Promise<OrderCancellationResult> {
    const row = await this.repo.findByClientOrderId(clientOrderId);
    if (!row || row.symbol !== symbol) return { confirmed: false, reason: "ORDER_IDENTITY_UNAVAILABLE" };
    if (!this.exchange) {
      if (row.simulated !== true && !row.binanceOrderId?.startsWith("SIM_")) {
        return { confirmed: false, reason: "EXCHANGE_ORDER_REQUIRES_EXCHANGE" };
      }
      const terminal = ["FILLED", "CANCELED", "REJECTED", "EXPIRED"].includes(row.status);
      const settled = terminal ? row : await this.repo.updateStatus(clientOrderId, "CANCELED");
      return { confirmed: true, execution: this.toResult(settled, 0, false) };
    }
    if (this.exchange.cancelOrder && ["NEW", "PARTIAL"].includes(row.status)) {
      try { await this.exchange.cancelOrder(symbol, clientOrderId); } catch { /* query decides */ }
    }
    try {
      const response = await this.exchange.queryOrder(symbol, clientOrderId);
      const quantity = Number(response.executedQty);
      if (response.executedQty == null || !Number.isFinite(quantity) || quantity < 0) {
        return { confirmed: false, reason: "CANCELLATION_FILL_QUANTITY_UNKNOWN" };
      }
      if (quantity < Number(row.filledQty ?? 0) - 1e-10 || quantity > row.qty + 1e-10) {
        return { confirmed: false, reason: "CANCELLATION_FILL_QUANTITY_INCONSISTENT" };
      }
      if (quantity > 0 && !(Number(response.avgPrice) > 0)) {
        return { confirmed: false, reason: "CANCELLATION_FILL_PRICE_UNKNOWN" };
      }
      const execution = await this.recordResponse(row, response, this.now());
      const confirmed = ["FILLED", "CANCELED", "REJECTED", "EXPIRED"].includes(execution.status);
      return { confirmed, execution, ...(confirmed ? {} : { reason: "CANCELLATION_NOT_TERMINAL" }) };
    } catch {
      return { confirmed: false, reason: "CANCELLATION_STATE_UNKNOWN" };
    }
  }
}

export const prismaOrderExecRepo: OrderExecRepo = {
  async findByClientOrderId(clientOrderId: string): Promise<OrderExecRow | null> {
    const row = await db.orderExec.findUnique({
      where: { clientOrderId },
    });
    return row;
  },

  async create(order: OrderExecRow): Promise<OrderExecRow> {
    const row = await db.orderExec.create({
      data: {
        clientOrderId: order.clientOrderId,
        binanceOrderId: order.binanceOrderId,
        symbol: order.symbol,
        type: order.type,
        side: order.side,
        price: order.price,
        qty: order.qty,
        reduceOnly: order.reduceOnly,
        status: order.status,
        fillPrice: order.fillPrice,
        feeUsd: order.feeUsd,
        positionId: order.positionId,
        createdAt: order.createdAt ?? new Date(),
        filledAt: order.filledAt,
        filledQty: order.filledQty,
        feeEstimated: order.feeEstimated,
        simulated: order.simulated,
      },
    });
    return row;
  },

  async updateStatus(
    clientOrderId: string,
    status: OrderStatus,
    fillPrice?: number,
    feeUsd?: number,
    filledAt?: Date,
    execution?: Partial<OrderExecRow>
  ): Promise<OrderExecRow> {
    // T-14 (CP-4): transisi state formal. Pelanggaran = warning (histori lama
    // tidak boleh membuat update gagal), tapi tercatat untuk audit.
    const current = await db.orderExec.findUnique({ where: { clientOrderId }, select: { status: true } });
    if (current && !canTransition(current.status, status)) {
      logger.warn({ clientOrderId, from: current.status, to: status }, "ORDER_STATE_ILLEGAL_TRANSITION");
    }
    const row = await db.orderExec.update({
      where: { clientOrderId },
      data: {
        status,
        fillPrice,
        feeUsd,
        filledAt,
        ...(execution?.filledQty !== undefined ? { filledQty: execution.filledQty } : {}),
        ...(execution?.binanceOrderId !== undefined ? { binanceOrderId: execution.binanceOrderId } : {}),
        ...(execution?.feeEstimated !== undefined ? { feeEstimated: execution.feeEstimated } : {}),
        ...(execution?.simulated !== undefined ? { simulated: execution.simulated } : {}),
      },
    });
    return row;
  },
};

// Enabling LIVE in config must never silently turn a paper fill into a trade.
// Private account reconciliation and protective-order lifecycle remain gated.
// TAHAP 5 audit (15 Okt 2026): verifier sentuhan harga paper berbasis kline 1m.
// LIMIT BUY fill hanya bila low kline <= price; LIMIT SELL bila high kline >= price.
// Kline dibaca sejak `sinceMs` (default: order dibuat). Jendela bar mengikuti
// jendela bukti: minimal 20 bar (~20 mnt utk order baru), maks 1500 bar (~25 jam)
// bila pemanggil meminta bukti sejak posisi dibuka (touchSinceMs = openedAt,
// fix lanjutan #3177 16 Okt 2026 — order exit yang ditempatkan telat tetap
// terisi oleh sentuhan level yang lebih awal).
export async function paperKlineTouchVerifier(
  symbol: string, price: number, side: string, sinceMs: number,
): Promise<boolean> {
  const bars = Number.isFinite(sinceMs) && sinceMs > 0
    ? Math.min(1500, Math.max(20, Math.ceil((Date.now() - sinceMs) / 60_000) + 2))
    : 20;
  const rows: unknown[] = await binanceFuturesClient.fetchKlines(symbol, "1m", bars);
  // Missing evidence is unknown, never proof of a LIMIT fill.
  if (!Array.isArray(rows) || rows.length === 0) return false;
  const isBuy = String(side).toUpperCase() === "BUY";
  for (const raw of rows) {
    if (!Array.isArray(raw)) continue;
    const openTime = Number(raw[0]); const h = Number(raw[2]); const l = Number(raw[3]);
    if (![openTime, h, l].every(Number.isFinite)) continue;
    // OHLC cannot locate a wick inside the minute in which the order was
    // created. Only candles beginning at/after creation are usable evidence.
    if (openTime < sinceMs) continue;
    if (isBuy ? l <= price : h >= price) return true;
  }
  return false;
}

export const defaultOrderExecutor = new OrderExecutor({
  paperAllowed: env.BINANCE_EXECUTION_MODE === "PAPER",
  paperTouchVerifier: env.PAPER_TOUCH_VERIFY ? paperKlineTouchVerifier : undefined,
  slippageEstimator: ({ price, qty }) => paperFillSlippageBps({ price, qty }),
});

/** Retained PAPER positions still need simulated exits after switching mode.
 * Never select this executor for a LIVE position or a new LIVE entry. */
export const paperPositionExecutor = new OrderExecutor({
  paperAllowed: true,
  paperTouchVerifier: env.PAPER_TOUCH_VERIFY ? paperKlineTouchVerifier : undefined,
  slippageEstimator: ({ price, qty }) => paperFillSlippageBps({ price, qty }),
});

