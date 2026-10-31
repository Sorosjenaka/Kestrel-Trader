import type { BinanceAlgoResponse } from "./binanceUsdMClient.js";
import { createHash } from "node:crypto";
import { BinanceUsdMClient } from "./binanceUsdMClient.js";
import type { OrderExecRepo, OrderExecRow } from "./orderExecutor.js";
import { prismaOrderExecRepo } from "./orderExecutor.js";

export interface ManagedStop {
  clientAlgoId: string;
  algoId: string;
  status: string;
  triggerPrice: number;
}

/** Private account controls and a durable close-all stop intent. The live entry
 * route is intentionally not connected until fills, stop triggers and wallet
 * reconciliation are unified with the Position/Trade ledger. */
export class FuturesOrderManager {
  constructor(
    private readonly exchange: BinanceUsdMClient,
    private readonly repo: OrderExecRepo = prismaOrderExecRepo,
  ) {}

  async prepareSymbol(symbol: string, leverage: number, marginMode: "CROSS" | "ISOLATED"): Promise<void> {
    if (await this.exchange.getPositionMode()) throw new Error("BINANCE_HEDGE_MODE_UNSUPPORTED");
    const before = await this.exchange.getPositionRisk(symbol);
    if (before.length !== 1 || before[0]?.symbol !== symbol) throw new Error("BINANCE_POSITION_STATE_UNKNOWN");
    if (!before[0].positionAmt || !Number.isFinite(Number(before[0].positionAmt))) throw new Error("BINANCE_POSITION_STATE_UNKNOWN");
    if (Number(before[0].positionAmt) !== 0) throw new Error("BINANCE_SYMBOL_ALREADY_HAS_POSITION");
    await this.exchange.setMarginType(symbol, marginMode);
    const applied = await this.exchange.setLeverage(symbol, leverage);
    if (applied !== leverage) throw new Error("BINANCE_LEVERAGE_MISMATCH");
    const after = await this.exchange.getPositionRisk(symbol);
    if (after.length !== 1 || after[0]?.symbol !== symbol || !after[0].positionAmt ||
        Number(after[0].positionAmt) !== 0 ||
        Number(after[0].leverage) !== leverage ||
        after[0].marginType?.toLowerCase() !== (marginMode === "CROSS" ? "cross" : "isolated")) {
      throw new Error("BINANCE_ACCOUNT_CONFIG_UNVERIFIED");
    }
  }

  /** Persist the intent before submitting. An uncertain POST is queried by ID;
   * it is never retried. One-way mode closePosition=true protects the whole
   * symbol position, including partial TP fills, without stale quantities. */
  async ensureCloseAllStop(input: {
    entryClientOrderId: string;
    symbol: string;
    positionSide: "LONG" | "SHORT";
    entryPrice: number;
    triggerPrice: number;
    filledQty: number;
  }): Promise<ManagedStop> {
    const { symbol, positionSide, entryPrice, triggerPrice, filledQty } = input;
    if (!(Number.isFinite(entryPrice) && entryPrice > 0 && Number.isFinite(triggerPrice) && triggerPrice > 0 &&
        Number.isFinite(filledQty) && filledQty > 0)) throw new Error("STOP_INPUT_INVALID");
    if (positionSide === "LONG" ? triggerPrice >= entryPrice : triggerPrice <= entryPrice) throw new Error("STOP_WRONG_SIDE");
    if (await this.exchange.getPositionMode()) throw new Error("BINANCE_HEDGE_MODE_UNSUPPORTED");
    const positions = await this.exchange.getPositionRisk(symbol);
    if (positions.length !== 1 || positions[0]?.symbol !== symbol) throw new Error("BINANCE_POSITION_STATE_UNKNOWN");
    const amount = Number(positions[0].positionAmt);
    if (!Number.isFinite(amount) || (positionSide === "LONG" ? amount <= 0 : amount >= 0) ||
        Math.abs(amount) + 1e-10 < filledQty) throw new Error("BINANCE_FILL_POSITION_MISMATCH");
    const clientAlgoId = input.entryClientOrderId.length <= 33
      ? `SL_${input.entryClientOrderId}`
      : `SL_${input.entryClientOrderId.slice(0, 24)}_${createHash("sha256").update(input.entryClientOrderId).digest("hex").slice(0, 8)}`;
    const side = positionSide === "LONG" ? "SELL" : "BUY";
    const existing = await this.repo.findByClientOrderId(clientAlgoId);
    if (existing) {
      if (existing.symbol !== symbol || existing.side !== side || existing.type !== "STOP_MARKET" ||
          existing.price !== triggerPrice || existing.qty !== filledQty || !existing.reduceOnly) {
        throw new Error("STOP_ID_CONFLICT");
      }
      const queried = await this.exchange.queryAlgo(clientAlgoId);
      return this.requireActive(await this.recordAlgo(existing, queried));
    }
    const intent: OrderExecRow = { clientOrderId: clientAlgoId, symbol, side, type: "STOP_MARKET",
      price: triggerPrice, qty: filledQty, reduceOnly: true, status: "NEW", filledQty: 0,
      feeEstimated: true, simulated: false };
    await this.repo.create(intent);
    try {
      return this.requireActive(await this.recordAlgo(intent, await this.exchange.placeCloseAllStop({ symbol, side, triggerPrice, clientAlgoId })));
    } catch (error) {
      // Transport timeout may mean accepted. Query is safe; a second POST is not.
      try { return this.requireActive(await this.recordAlgo(intent, await this.exchange.queryAlgo(clientAlgoId))); }
      catch { throw error; }
    }
  }

  private requireActive(stop: ManagedStop): ManagedStop {
    if (stop.status !== "NEW") throw new Error("BINANCE_STOP_NOT_ACTIVE");
    return stop;
  }

  async queryStop(clientAlgoId: string): Promise<ManagedStop> {
    const row = await this.repo.findByClientOrderId(clientAlgoId);
    if (!row || row.type !== "STOP_MARKET" || row.simulated) throw new Error("STOP_INTENT_NOT_FOUND");
    return this.recordAlgo(row, await this.exchange.queryAlgo(clientAlgoId));
  }

  async cancelStop(clientAlgoId: string): Promise<ManagedStop> {
    const row = await this.repo.findByClientOrderId(clientAlgoId);
    if (!row || row.type !== "STOP_MARKET" || row.simulated) throw new Error("STOP_INTENT_NOT_FOUND");
    const positions = await this.exchange.getPositionRisk(row.symbol);
    if (positions.length !== 1 || positions[0]?.symbol !== row.symbol ||
        !positions[0].positionAmt || !Number.isFinite(Number(positions[0].positionAmt))) {
      throw new Error("BINANCE_POSITION_STATE_UNKNOWN");
    }
    if (Number(positions[0].positionAmt) !== 0) throw new Error("STOP_CANCEL_REQUIRES_FLAT_POSITION");
    try { return this.recordAlgo(row, await this.exchange.cancelAlgo(clientAlgoId)); }
    catch (error) {
      // Cancellation may have succeeded even if the reply was lost.
      try {
        const queried = await this.exchange.queryAlgo(clientAlgoId);
        const result = await this.recordAlgo(row, queried);
        if (result.status === "CANCELED") return result;
      } catch { /* keep original uncertainty */ }
      throw error;
    }
  }

  private async recordAlgo(row: OrderExecRow, response: BinanceAlgoResponse): Promise<ManagedStop> {
    if (response.clientAlgoId !== row.clientOrderId || response.symbol !== row.symbol ||
        !Number.isFinite(Number(response.algoId)) || Number(response.triggerPrice) !== row.price) {
      throw new Error("BINANCE_STOP_RESPONSE_MISMATCH");
    }
    const status = response.algoStatus;
    const allowed = ["NEW", "TRIGGERED", "FINISHED", "CANCELED", "EXPIRED", "REJECTED"];
    if (!allowed.includes(status)) throw new Error("BINANCE_STOP_STATUS_UNKNOWN");
    // Algo status only describes the trigger, not the resulting trade fill.
    // Keep it non-filled until the exchange position/trade ledger is reconciled.
    await this.repo.updateStatus(row.clientOrderId,
      status === "TRIGGERED" || status === "FINISHED" ? "PARTIAL" : status as "NEW" | "CANCELED" | "EXPIRED" | "REJECTED",
      undefined, undefined, undefined, { binanceOrderId: String(response.algoId) });
    return { clientAlgoId: row.clientOrderId, algoId: String(response.algoId), status, triggerPrice: row.price };
  }
}
