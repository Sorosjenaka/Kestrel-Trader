import { createHmac } from "node:crypto";
import type { ExchangeClient, OrderRequest } from "./orderExecutor.js";

// Private USD-M endpoint only. A caller cannot redirect signed requests to a
// public REST fallback host, testnet, or an arbitrary URL.
const BASE_URL = "https://fapi.binance.com";
const SYMBOL = /^[A-Z0-9]{3,30}$/;
const CLIENT_ID = /^[A-Za-z0-9_\-]{1,36}$/;

export interface BinanceOrderResponse {
  orderId: number | string;
  status: string;
  avgPrice?: string;
  executedQty?: string;
  cumQuote?: string;
}

export interface BinanceAlgoResponse {
  algoId: number | string;
  clientAlgoId: string;
  algoStatus: string;
  symbol: string;
  triggerPrice: string;
  /** Exchange orderId of the child order; empty string if not yet triggered. */
  actualOrderId?: string;
  /** Average fill price of the child order; "0" if not triggered/filled. */
  actualPrice?: string;
  /** Filled quantity of the child order; present only when triggered/filled. */
  actualQty?: string;
  /** Order type of the child order; present only when triggered. */
  actualType?: string;
}

export interface BinanceBalanceRow {
  asset: string;
  balance: string;
  availableBalance: string;
}

export interface BinancePositionRiskRow {
  symbol: string;
  positionAmt: string;
  leverage: string;
  marginType: string;
  entryPrice?: string;
  markPrice?: string;
}

export interface BinanceOpenOrderRow {
  symbol: string;
  orderId: number | string;
  clientOrderId?: string;
  type: string;
  side: string;
  price?: string;
  origQty?: string;
  executedQty?: string;
  reduceOnly?: boolean;
  status?: string;
  stopPrice?: string;
}

export interface BinanceUserTradeRow {
  id: number;
  symbol: string;
  side: string;
  price: string;
  qty: string;
  quoteQty: string;
  realizedPnl: string;
  commission: string;
  commissionAsset: string;
  time: number;
}

export interface BinanceIncomeRow {
  symbol?: string;
  incomeType: string;
  income: string;
  asset: string;
  time: number;
}

export class BinanceRequestError extends Error {
  constructor(public readonly httpStatus: number, public readonly code: number | null, message: string) {
    super(`Binance request failed (HTTP ${httpStatus}, code ${code ?? "unknown"}): ${message}`);
    this.name = "BinanceRequestError";
  }
}

function decimal(value: number): string {
  if (!Number.isFinite(value) || value <= 0) throw new Error("Binance order value must be finite and positive");
  // Avoid JS scientific notation, which the exchange does not accept for lots.
  const fixed = value.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
  if (!fixed || fixed === "0") throw new Error("Binance order value rounds to zero");
  return fixed;
}

function assertSymbol(symbol: string): void {
  if (!SYMBOL.test(symbol)) throw new Error("Invalid Binance symbol");
}

function assertClientId(id: string): void {
  if (!CLIENT_ID.test(id)) throw new Error("Invalid Binance client id");
}

function checkedOrder(response: BinanceOrderResponse): BinanceOrderResponse {
  if (!response || !/^[0-9]+$/.test(String(response.orderId)) ||
      !["NEW", "PARTIALLY_FILLED", "FILLED", "CANCELED", "REJECTED", "EXPIRED", "EXPIRED_IN_MATCH"].includes(response.status) ||
      !Number.isFinite(Number(response.executedQty)) || Number(response.executedQty) < 0) {
    throw new Error("BINANCE_ORDER_RESPONSE_INVALID");
  }
  return response;
}

/** Signed HTTP adapter. Mutating calls are made once; a timeout is *unknown*,
 * never a signal to blindly repeat POST. Reconcile by the deterministic id. */
export class BinanceUsdMClient implements ExchangeClient {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(options: { apiKey: string; apiSecret: string; fetcher?: typeof fetch; now?: () => number; timeoutMs?: number }) {
    if (!options.apiKey || !options.apiSecret) throw new Error("Binance live credentials are missing");
    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  private readonly apiKey: string;
  private readonly apiSecret: string;

  private async signed<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, fields: Record<string, string>): Promise<T> {
    const params = new URLSearchParams({ ...fields, recvWindow: "5000", timestamp: String(Math.trunc(this.now())) });
    const signature = createHmac("sha256", this.apiSecret).update(params.toString()).digest("hex");
    params.set("signature", signature);
    const body = params.toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const hasBody = method === "POST" || method === "PUT";
      const response = await this.fetcher(
        `${BASE_URL}${path}${method === "GET" || method === "DELETE" ? `?${body}` : ""}`,
        { method, headers: { "X-MBX-APIKEY": this.apiKey,
          ...(hasBody ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
          ...(hasBody ? { body } : {}), signal: controller.signal },
      );
      const raw = await response.text();
      let data: unknown;
      try { data = JSON.parse(raw); } catch { throw new BinanceRequestError(response.status, null, "invalid JSON response"); }
      if (!response.ok) {
        const error = data && typeof data === "object" ? data as Record<string, unknown> : {};
        const code = typeof error.code === "number" ? error.code : null;
        // Exchange error text can echo request data; keep logs free of secrets.
        throw new BinanceRequestError(response.status, code, "exchange rejected request");
      }
      return data as T;
    } finally { clearTimeout(timer); }
  }

  async postOrder(req: OrderRequest & { clientOrderId: string }): Promise<BinanceOrderResponse> {
    assertSymbol(req.symbol);
    assertClientId(req.clientOrderId);
    if (req.type !== "MARKET" && req.type !== "LIMIT") throw new Error("Conditional orders require the algo endpoint");
    const fields: Record<string, string> = {
      symbol: req.symbol, side: req.side, type: req.type, quantity: decimal(req.qty),
      newClientOrderId: req.clientOrderId, newOrderRespType: "RESULT", positionSide: "BOTH",
    };
    if (req.type === "LIMIT") Object.assign(fields, {
      price: decimal(req.price),
      timeInForce: req.timeInForce ?? "GTC",
    });
    if (req.reduceOnly) fields.reduceOnly = "true";
    return checkedOrder(await this.signed("POST", "/fapi/v1/order", fields));
  }

  /**
   * T-11 (CP-4, 19 Okt 2026): amend harga/qty order LIMIT yang masih NEW.
   * Tidak dipanggil jalur produksi sampai `LIVE_ORDER_AMEND_ENABLED=true` dan
   * probe zero-risk exchange selesai. Idempoten lewat clientOrderId.
   */
  async amendOrder(symbol: string, clientOrderId: string, patch: { price?: number; qty?: number }): Promise<BinanceOrderResponse> {
    assertSymbol(symbol);
    assertClientId(clientOrderId);
    if (patch.price == null && patch.qty == null) throw new Error("AMEND_PATCH_EMPTY");
    const fields: Record<string, string> = { symbol, origClientOrderId: clientOrderId };
    if (patch.price != null) fields.price = decimal(patch.price);
    if (patch.qty != null) fields.quantity = decimal(patch.qty);
    return checkedOrder(await this.signed("PUT", "/fapi/v1/order", fields));
  }

  /** T-13 (CP-4): order book publik untuk depth guard pre-entry LIVE. */
  async getDepth(symbol: string, limit = 20): Promise<{ bids: Array<[string, string]>; asks: Array<[string, string]> }> {
    assertSymbol(symbol);
    const lim = Math.max(5, Math.min(1000, Math.trunc(limit)));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetcher(`${BASE_URL}/fapi/v1/depth?symbol=${symbol}&limit=${lim}`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`BINANCE_DEPTH_HTTP_${res.status}`);
      const body = await res.json() as { bids?: unknown; asks?: unknown };
      if (!Array.isArray(body.bids) || !Array.isArray(body.asks)) throw new Error("BINANCE_DEPTH_RESPONSE_INVALID");
      const valid = (rows: unknown[]): rows is Array<[string, string]> =>
        rows.every((r) => Array.isArray(r) && r.length >= 2);
      if (!valid(body.bids) || !valid(body.asks)) throw new Error("BINANCE_DEPTH_RESPONSE_INVALID");
      return { bids: body.bids, asks: body.asks };
    } finally {
      clearTimeout(timer);
    }
  }

  async queryOrder(symbol: string, clientOrderId: string): Promise<BinanceOrderResponse> {
    assertSymbol(symbol);
    assertClientId(clientOrderId);
    return checkedOrder(await this.signed("GET", "/fapi/v1/order", { symbol, origClientOrderId: clientOrderId }));
  }

  /** Batalkan order (entry LIMIT timeout). Order tidak ditemukan = sudah bersih. */
  async cancelOrder(symbol: string, clientOrderId: string): Promise<{ status?: string }> {
    assertSymbol(symbol);
    assertClientId(clientOrderId);
    const res = await this.signed("DELETE", "/fapi/v1/order", { symbol, origClientOrderId: clientOrderId });
    return { status: String((res as { status?: string }).status ?? "CANCELED") };
  }

  async getPositionMode(): Promise<boolean> {
    const result = await this.signed<{ dualSidePosition: boolean }>("GET", "/fapi/v1/positionSide/dual", {});
    if (typeof result.dualSidePosition !== "boolean") throw new Error("Position mode response invalid");
    return result.dualSidePosition;
  }

  /** Saldo seluruh aset (signed); caller memilih USDT. */
  async getBalances(): Promise<BinanceBalanceRow[]> {
    const result = await this.signed<unknown>("GET", "/fapi/v2/balance", {});
    if (!Array.isArray(result)) throw new Error("Balance response invalid");
    return result as BinanceBalanceRow[];
  }

  /** Posisi seluruh simbol (signed); positionAmt 0 = flat. */
  async getPositionRiskAll(): Promise<BinancePositionRiskRow[]> {
    const result = await this.signed<unknown>("GET", "/fapi/v2/positionRisk", {});
    if (!Array.isArray(result)) throw new Error("Position risk response invalid");
    return result as BinancePositionRiskRow[];
  }

  /** Daftar algo order terbuka (SL/TP resting di exchange). */
  async getOpenAlgoOrders(): Promise<unknown[]> {
    const result = await this.signed<unknown>("GET", "/fapi/v1/openAlgoOrders", {});
    // Response berbentuk { orders: [...] } atau array langsung tergantung versi.
    if (Array.isArray(result)) return result;
    const orders = (result as { orders?: unknown }).orders;
    if (Array.isArray(orders)) return orders;
    throw new Error("Open algo orders response invalid");
  }

  /** Cancel semua order reguler terbuka per simbol (dipakai kill switch). */
  async cancelAllOrders(symbol: string): Promise<void> {
    assertSymbol(symbol);
    await this.signed("DELETE", "/fapi/v1/allOpenOrders", { symbol });
  }

  /** Daftar order reguler terbuka (tanpa symbol = semua). Read-only. */
  async getOpenOrders(symbol?: string): Promise<BinanceOpenOrderRow[]> {
    const fields: Record<string, string> = {};
    if (symbol) { assertSymbol(symbol); fields.symbol = symbol; }
    const result = await this.signed<unknown>("GET", "/fapi/v1/openOrders", fields);
    if (!Array.isArray(result)) throw new Error("Open orders response invalid");
    return result as BinanceOpenOrderRow[];
  }

  async getPositionRisk(symbol: string): Promise<Array<{ symbol: string; positionAmt: string; leverage: string; marginType: string }>> {
    assertSymbol(symbol);
    const result = await this.signed<unknown>("GET", "/fapi/v2/positionRisk", { symbol });
    if (!Array.isArray(result)) throw new Error("Position risk response invalid");
    return result as Array<{ symbol: string; positionAmt: string; leverage: string; marginType: string }>;
  }

  async setLeverage(symbol: string, leverage: number): Promise<number> {
    assertSymbol(symbol);
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > 125) throw new Error("Invalid leverage");
    const result = await this.signed<{ leverage: number }>("POST", "/fapi/v1/leverage", { symbol, leverage: String(leverage) });
    if (!Number.isInteger(result.leverage)) throw new Error("Leverage response invalid");
    return result.leverage;
  }

  async setMarginType(symbol: string, mode: "CROSS" | "ISOLATED"): Promise<void> {
    assertSymbol(symbol);
    try {
      await this.signed("POST", "/fapi/v1/marginType", { symbol, marginType: mode === "CROSS" ? "CROSSED" : "ISOLATED" });
    } catch (error) {
      // -4046 means "No need to change margin type". Confirm the state in
      // prepareSymbol() regardless; never trust this response on its own.
      if (!(error instanceof BinanceRequestError && error.code === -4046)) throw error;
    }
  }

  async placeCloseAllStop(input: { symbol: string; side: "BUY" | "SELL"; triggerPrice: number; clientAlgoId: string }): Promise<BinanceAlgoResponse> {
    assertSymbol(input.symbol);
    assertClientId(input.clientAlgoId);
    return this.signed("POST", "/fapi/v1/algoOrder", {
      algoType: "CONDITIONAL", type: "STOP_MARKET", symbol: input.symbol,
      side: input.side, positionSide: "BOTH", triggerPrice: decimal(input.triggerPrice),
      workingType: "MARK_PRICE", closePosition: "true", clientAlgoId: input.clientAlgoId,
    });
  }

  /** PRE-ENTRY guard (12 Okt 2026, perintah operator "pasang SL/TP dulu, verifikasi,
   * baru entry"): reduceOnly + quantity — DITERIMA tanpa posisi terbuka (closePosition
   * ditolak -4509, terbukti lewat probe zero-risk 11 Okt). ReduceOnly = tidak pernah
   * membuka posisi; batal otomatis saat posisi tidak ada. */
  async placeReduceOnlyGuard(input: {
    symbol: string; side: "BUY" | "SELL"; type: "STOP_MARKET" | "TAKE_PROFIT";
    triggerPrice: number; quantity: number; clientAlgoId: string; price?: number;
  }): Promise<BinanceAlgoResponse> {
    assertSymbol(input.symbol);
    assertClientId(input.clientAlgoId);
    const qty = decimal(input.quantity);
    const fields: Record<string, string> = {
      algoType: "CONDITIONAL", type: input.type, symbol: input.symbol,
      side: input.side, positionSide: "BOTH", triggerPrice: decimal(input.triggerPrice),
      workingType: "MARK_PRICE", closePosition: "false", reduceOnly: "true",
      quantity: qty, timeInForce: "GTC", clientAlgoId: input.clientAlgoId,
    };
    // TAKE_PROFIT = limit maker saat trigger (fee TP = maker); STOP_MARKET = taker.
    if (input.type === "TAKE_PROFIT") fields.price = decimal(input.price ?? input.triggerPrice);
    return this.signed("POST", "/fapi/v1/algoOrder", fields);
  }

  async queryAlgo(clientAlgoId: string): Promise<BinanceAlgoResponse> {
    assertClientId(clientAlgoId);
    return this.signed("GET", "/fapi/v1/algoOrder", { clientAlgoId });
  }

  /**
   * T-11 (CP-4, 19 Okt 2026): TRAILING_STOP_MARKET sebagai guard reduce-only.
   * BELUM diprobe ke exchange — hanya dipanggil bila operator menyalakan
   * `LIVE_ORDER_AMEND_ENABLED` setelah probe zero-risk. Parameter callbackRate
   * dalam persen (mis. 1.5 = 1.5%).
   */
  async placeTrailingStopGuard(input: {
    symbol: string; side: "BUY" | "SELL"; activationPrice: number;
    callbackRatePct: number; quantity: number; clientAlgoId: string;
  }): Promise<BinanceAlgoResponse> {
    assertSymbol(input.symbol);
    assertClientId(input.clientAlgoId);
    if (!(input.callbackRatePct > 0 && input.callbackRatePct <= 5)) throw new Error("TRAILING_CALLBACK_RATE_INVALID");
    return this.signed("POST", "/fapi/v1/algoOrder", {
      algoType: "CONDITIONAL", type: "TRAILING_STOP_MARKET", symbol: input.symbol,
      side: input.side, positionSide: "BOTH", activationPrice: decimal(input.activationPrice),
      callbackRate: String(input.callbackRatePct), workingType: "MARK_PRICE",
      closePosition: "false", reduceOnly: "true", quantity: decimal(input.quantity),
      clientAlgoId: input.clientAlgoId,
    });
  }

  async cancelAlgo(clientAlgoId: string): Promise<BinanceAlgoResponse> {
    assertClientId(clientAlgoId);
    return this.signed("DELETE", "/fapi/v1/algoOrder", { clientAlgoId });
  }

  /** Account Trade List (READ-ONLY). Halaman pertama memakai startTime/endTime;
   * halaman lanjutan WAJIB fromId saja (kontrak Binance: fromId tidak boleh
   * digabung startTime/endTime; jendela maks 7 hari). Dipakai akuntansi exit
   * CP-1 (12 Okt 2026): fill asli, bukan harga trigger. */
  async getUserTrades(input: { symbol: string; startTime?: number; endTime?: number; fromId?: number; limit?: number }): Promise<BinanceUserTradeRow[]> {
    assertSymbol(input.symbol);
    if (input.fromId !== undefined && (input.startTime !== undefined || input.endTime !== undefined)) {
      throw new Error("getUserTrades: fromId cannot be combined with startTime/endTime");
    }
    const fields: Record<string, string> = { symbol: input.symbol };
    if (input.startTime !== undefined) fields.startTime = String(Math.trunc(input.startTime));
    if (input.endTime !== undefined) fields.endTime = String(Math.trunc(input.endTime));
    if (input.fromId !== undefined) fields.fromId = String(Math.trunc(input.fromId));
    fields.limit = String(Math.min(Math.max(Math.trunc(input.limit ?? 1000), 1), 1000));
    return this.signed("GET", "/fapi/v1/userTrades", fields);
  }

  /** Income history (READ-ONLY): FUNDING_FEE, COMMISSION, REALIZED_PNL, dst.
   * Dipakai rekonsiliasi funding pada akuntansi exit CP-1 (12 Okt 2026). */
  async getIncome(input: { symbol?: string; incomeType?: string; startTime?: number; endTime?: number; limit?: number }): Promise<BinanceIncomeRow[]> {
    const fields: Record<string, string> = {};
    if (input.symbol !== undefined) { assertSymbol(input.symbol); fields.symbol = input.symbol; }
    if (input.incomeType !== undefined) fields.incomeType = input.incomeType;
    if (input.startTime !== undefined) fields.startTime = String(Math.trunc(input.startTime));
    if (input.endTime !== undefined) fields.endTime = String(Math.trunc(input.endTime));
    fields.limit = String(Math.min(Math.max(Math.trunc(input.limit ?? 1000), 1), 1000));
    return this.signed("GET", "/fapi/v1/income", fields);
  }
}
