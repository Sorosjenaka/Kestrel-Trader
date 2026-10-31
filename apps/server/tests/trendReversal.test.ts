// apps/server/tests/trendReversal.test.ts - Uji TREND-REVERSAL EXIT (12 AI Agents baca arah trend)
// + penjaga kelas aset (komoditas BZUSDT dkk diblokir, crypto lolos).
import { describe, expect, it } from "vitest";
import {
  isTrendAgainstPosition,
  classifyFlipStrength,
  decideTrendExit,
  parseTrendAnswer,
  readTrendWithAgents,
  confirmedMacroFlipDirection,
  TrendFlipConfirmationGuard,
  TREND_FLIP_CONFIRMATION_MIN_MS,
  type TrendReadingInput,
} from "../src/agents/trendReversalEngine.js";
import {
  checkAssetClass,
  isCryptoTradeable,
  extractBaseAsset,
  setExchangeNonCrypto,
  clearExchangeNonCrypto,
  exchangeNonCryptoCount,
  classifyExchangeNonCrypto,
  REASON_COMMODITY,
  REASON_EQUITY,
} from "../src/universe/assetClassGuard.js";
import { PositionSupervisor, PositionRepo, PositionRow, TradeRow } from "../src/exec/positionSupervisor.js";
import { OrderExecutor, OrderExecRepo, OrderExecRow, OrderStatus } from "../src/exec/orderExecutor.js";

class MemoryPositionRepo implements PositionRepo {
  private positions = new Map<number, PositionRow>();
  private trades = new Map<number, TradeRow>();
  public loggedEvents: Array<{ action: string; symbol: string; payload: Record<string, unknown> }> = [];

  async findOpenPositions(symbol?: string): Promise<PositionRow[]> {
    return Array.from(this.positions.values()).filter((p) => p.status === "OPEN" && (!symbol || p.symbol === symbol));
  }
  async findById(id: number): Promise<PositionRow | null> {
    return this.positions.get(id) ?? null;
  }
  async createPosition(data: Omit<PositionRow, "id">): Promise<PositionRow> {
    const pos: PositionRow = { ...data, id: this.positions.size + 1 };
    this.positions.set(pos.id, pos);
    return pos;
  }
  async updatePosition(id: number, data: Partial<PositionRow>): Promise<PositionRow> {
    const existing = this.positions.get(id);
    if (!existing) throw new Error("Position not found");
    const updated = { ...existing, ...data };
    this.positions.set(id, updated);
    return updated;
  }
  async createTrade(data: TradeRow): Promise<TradeRow> {
    const trade = { ...data, id: this.trades.size + 1 };
    this.trades.set(trade.positionId, trade);
    return trade;
  }
  async closePositionWithTrade(positionId: number, patch: Partial<PositionRow>, trade: TradeRow): Promise<TradeRow> {
    await this.updatePosition(positionId, patch);
    return this.createTrade(trade);
  }
  async logEvent(action: string, symbol: string, payload: Record<string, unknown>): Promise<void> {
    this.loggedEvents.push({ action, symbol, payload });
  }
  getTrade(positionId: number): TradeRow | undefined {
    return this.trades.get(positionId);
  }
}

class DummyOrderRepo implements OrderExecRepo {
  private rows = new Map<string, OrderExecRow>();
  async findByClientOrderId(id: string) { return this.rows.get(id) ?? null; }
  async create(row: OrderExecRow) { this.rows.set(row.clientOrderId, row); return row; }
  async updateStatus(id: string, status: OrderStatus, fillPrice?: number, feeUsd?: number, filledAt?: Date) {
    const r = this.rows.get(id)!;
    const upd = { ...r, status, fillPrice: fillPrice ?? r.fillPrice, feeUsd: feeUsd ?? r.feeUsd, filledAt };
    this.rows.set(id, upd);
    return upd;
  }
}

function baseInput(over: Partial<TrendReadingInput> = {}): TrendReadingInput {
  return {
    symbol: "SUIUSDT",
    side: "LONG",
    entryPrice: 1.02,
    currentPrice: 1.0,
    zlemaDirection: "BEARISH",
    zlemaIsFlip: true,
    trendScore: 80,
    adx: 30,
    chg1hPct: -1.2,
    btcTrend: "BEARISH",
    ethTrend: "BEARISH",
    btcDomChg1hPct: 0.2,
    unrealizedNetUsd: -1.4,
    beMoved: false,
    holdMinutes: 12,
    ...over,
  };
}

describe("Penjaga kelas aset: crypto-only (BZUSDT komoditas diblokir)", () => {
  it("BZUSDT (Brent Oil) diblokir sebagai COMMODITY", () => {
    const c = checkAssetClass("BZUSDT");
    expect(c.blocked).toBe(true);
    expect(c.assetClass).toBe("COMMODITY");
    expect(c.reason).toBe(REASON_COMMODITY);
    expect(isCryptoTradeable("BZUSDT")).toBe(false);
  });

  it("komoditas & equity lain juga diblokir", () => {
    expect(checkAssetClass("XAUUSDT").assetClass).toBe("COMMODITY");
    expect(checkAssetClass("WTIUSDT").assetClass).toBe("COMMODITY");
    expect(checkAssetClass("NGUSDT").assetClass).toBe("COMMODITY");
    expect(checkAssetClass("QQQUSDT").assetClass).toBe("EQUITY");
    expect(checkAssetClass("QQQUSDT").reason).toBe(REASON_EQUITY);
  });

  it("crypto murni lolos, multiplier 1000 tidak salah klasifikasi", () => {
    expect(extractBaseAsset("1000PEPEUSDT")).toBe("PEPE");
    expect(isCryptoTradeable("1000PEPEUSDT")).toBe(true);
    expect(isCryptoTradeable("SUIUSDT")).toBe(true);
    expect(isCryptoTradeable("BNBUSDT")).toBe(true);
    expect(isCryptoTradeable("BTCUSDT")).toBe(true);
  });

  it("blacklist manual operator menang", () => {
    const manual = new Set(["SUIUSDT"]);
    expect(checkAssetClass("SUIUSDT", manual).blocked).toBe(true);
    expect(checkAssetClass("SUIUSDT", manual).reason).toBe("MANUAL_BLACKLIST");
  });

  it("registry dinamis exchangeInfo memblokir simbol TRADFI yang TIDAK ada di daftar statis", () => {
    // KORUUSDT & SKHYNIXUSDT nyata lolos daftar statis (celah yang pernah terjadi).
    const blocked = setExchangeNonCrypto([
      { symbol: "KORUUSDT", contractType: "TRADIFI_PERPETUAL", underlyingType: "EQUITY", quoteAsset: "USDT", status: "TRADING" },
      { symbol: "SKHYNIXUSDT", contractType: "TRADIFI_PERPETUAL", underlyingType: "KR_EQUITY", quoteAsset: "USDT", status: "TRADING" },
      { symbol: "PLTRUSDT", contractType: "TRADIFI_PERPETUAL", underlyingType: "EQUITY", quoteAsset: "USDT", status: "TRADING" },
      { symbol: "XPTUSDT", contractType: "TRADIFI_PERPETUAL", underlyingType: "COMMODITY", quoteAsset: "USDT", status: "TRADING" },
      { symbol: "USDBRLUSDT", contractType: "TRADIFI_PERPETUAL", underlyingType: "FX", quoteAsset: "USDT", status: "TRADING" },
      { symbol: "OPENAIUSDT", contractType: "TRADIFI_PERPETUAL", underlyingType: "PREMARKET", quoteAsset: "USDT", status: "TRADING" },
      { symbol: "ALLUSDT", contractType: "PERPETUAL", underlyingType: "INDEX", quoteAsset: "USDT", status: "TRADING" },
      { symbol: "BTCUSDT_261225", contractType: "CURRENT_QUARTER", underlyingType: "COIN", quoteAsset: "USDT", status: "TRADING" },
      { symbol: "OLDUSDT", contractType: "PERPETUAL", underlyingType: "COIN", quoteAsset: "USDT", status: "BREAK" },
      { symbol: "ETHUSD_PERP", contractType: "PERPETUAL", underlyingType: "COIN", quoteAsset: "USD_PERP", status: "TRADING" },
      // Simbol crypto sah — TIDAK boleh masuk registry.
      { symbol: "BTCUSDT", contractType: "PERPETUAL", underlyingType: "COIN", quoteAsset: "USDT", status: "TRADING" },
      { symbol: "SOLUSDT", contractType: "PERPETUAL", underlyingType: "COIN", quoteAsset: "USDT", status: "TRADING" },
    ]);
    try {
      expect(blocked).toBe(10);
      expect(exchangeNonCryptoCount()).toBe(10);

      // Simbol yang lolos daftar statis sekarang ikut diblokir.
      const koru = checkAssetClass("KORUUSDT");
      expect(koru.blocked).toBe(true);
      expect(koru.assetClass).toBe("EQUITY");
      expect(koru.reason).toBe("non-crypto:EQUITY");

      expect(checkAssetClass("SKHYNIXUSDT").blocked).toBe(true);
      expect(checkAssetClass("SKHYNIXUSDT").assetClass).toBe("EQUITY");
      expect(checkAssetClass("PLTRUSDT").blocked).toBe(true);

      const xpt = checkAssetClass("XPTUSDT");
      expect(xpt.blocked).toBe(true);
      expect(xpt.assetClass).toBe("COMMODITY");

      expect(checkAssetClass("USDBRLUSDT").assetClass).toBe("FX");
      expect(checkAssetClass("OPENAIUSDT").assetClass).toBe("EQUITY");
      expect(checkAssetClass("ALLUSDT").assetClass).toBe("INDEX");
      expect(checkAssetClass("BTCUSDT_261225").blocked).toBe(true); // format juga menolak
      expect(checkAssetClass("OLDUSDT").reason).toBe("status:BREAK");
      expect(checkAssetClass("ETHUSD_PERP").reason).toBe("SYMBOL_FORMAT_INVALID");

      // Crypto sah tetap lolos walau registry terisi.
      expect(checkAssetClass("BTCUSDT").blocked).toBe(false);
      expect(checkAssetClass("SOLUSDT").blocked).toBe(false);
      expect(isCryptoTradeable("SUIUSDT")).toBe(true);
    } finally {
      clearExchangeNonCrypto();
    }
    expect(exchangeNonCryptoCount()).toBe(0);
  });

  it("classifyExchangeNonCrypto: deny-by-default & daftar statis tetap jadi fallback offline", () => {
    // Whitelist ketat: hanya PERPETUAL + COIN + USDT + TRADING yang lolos.
    expect(classifyExchangeNonCrypto({ symbol: "BTCUSDT", contractType: "PERPETUAL", underlyingType: "COIN", quoteAsset: "USDT", status: "TRADING" })).toBeNull();
    expect(classifyExchangeNonCrypto({ symbol: "BTCDOMUSDT", contractType: "PERPETUAL", underlyingType: "INDEX", quoteAsset: "USDT", status: "TRADING" })).toBe("BTCDOM-data-only");
    expect(classifyExchangeNonCrypto({ symbol: "QQQUSDT", contractType: "TRADIFI_PERPETUAL", underlyingType: "EQUITY", quoteAsset: "USDT", status: "TRADING" })).toBe("non-crypto:EQUITY");
    expect(classifyExchangeNonCrypto({ symbol: "OLDUSDT", contractType: "PERPETUAL", underlyingType: "COIN", quoteAsset: "USDT", status: "BREAK" })).toBe("status:BREAK");

    // Registry kosong (offline / belum sync): daftar statis masih memblokir.
    clearExchangeNonCrypto();
    expect(checkAssetClass("BZUSDT").blocked).toBe(true);
    expect(checkAssetClass("XAUUSDT").blocked).toBe(true);
    expect(checkAssetClass("SPYUSDT").blocked).toBe(true);
    expect(checkAssetClass("WTIUSDT").blocked).toBe(true);
  });
});

describe("Trend-reversal: arah vs posisi & kekuatan sinyal", () => {
  it("LONG melawan BEARISH, SHORT melawan BULLISH, searah/NEUTRAL aman", () => {
    expect(isTrendAgainstPosition("LONG", "BEARISH")).toBe(true);
    expect(isTrendAgainstPosition("SHORT", "BULLISH")).toBe(true);
    expect(isTrendAgainstPosition("LONG", "BULLISH")).toBe(false);
    expect(isTrendAgainstPosition("SHORT", "BEARISH")).toBe(false);
    expect(isTrendAgainstPosition("LONG", "NEUTRAL")).toBe(false);
  });

  it("klasifikasi kekuatan: flip + skor tinggi + ADX kuat + conf tinggi = STRONG", () => {
    expect(classifyFlipStrength({ zlemaIsFlip: true, trendScore: 80, adx: 30, confidence: 0.85 })).toBe("STRONG");
    expect(classifyFlipStrength({ zlemaIsFlip: false, trendScore: 55, adx: 18, confidence: 0.4 })).toBe("WEAK");
    expect(classifyFlipStrength({ zlemaIsFlip: true, trendScore: 62, adx: 21, confidence: 0.66 })).toBe("MODERATE");
  });

  it("keputusan exit: STRONG melawan = EXIT_NOW; MODERATE + TP1 terkunci = EXIT_NOW", () => {
    expect(decideTrendExit({ side: "LONG", newTrend: "BEARISH", strength: "STRONG", beMoved: false, unrealizedNetUsd: -1.4 }))
      .toEqual({ shouldExit: true, exitUrgency: "EXIT_NOW" });
    expect(decideTrendExit({ side: "LONG", newTrend: "BEARISH", strength: "MODERATE", beMoved: true, unrealizedNetUsd: 0.2 }))
      .toEqual({ shouldExit: true, exitUrgency: "EXIT_NOW" });
    expect(decideTrendExit({ side: "LONG", newTrend: "BEARISH", strength: "MODERATE", beMoved: false, unrealizedNetUsd: 0.3 }))
      .toEqual({ shouldExit: false, exitUrgency: "WATCH" });
    expect(decideTrendExit({ side: "LONG", newTrend: "BEARISH", strength: "WEAK", beMoved: false, unrealizedNetUsd: -0.5 }))
      .toEqual({ shouldExit: false, exitUrgency: "HOLD" });
    expect(decideTrendExit({ side: "LONG", newTrend: "BULLISH", strength: "STRONG", beMoved: false, unrealizedNetUsd: 0.9 }))
      .toEqual({ shouldExit: false, exitUrgency: "HOLD" });
  });

  it("parser jawaban agen: ARAH + KEYAKINAN", () => {
    expect(parseTrendAnswer("ARAH=BEARISH KEYAKINAN=[80]")).toEqual({ newTrend: "BEARISH", confidence: 0.8 });
    expect(parseTrendAnswer("arah bullish keyakinan=65")).toEqual({ newTrend: "BULLISH", confidence: 0.65 });
    expect(parseTrendAnswer("tidak jelas")).toEqual({ newTrend: "NEUTRAL", confidence: 0.6 });
  });

  it("macro flip butuh BTC+ETH searah, ADX kuat, dan momentum 1h searah", () => {
    const strongBear = { side: "LONG" as const, btcTrend: "BEARISH" as const, ethTrend: "BEARISH" as const, btcAdx: 27, btcChange1hPct: -0.4 };
    expect(confirmedMacroFlipDirection(strongBear)).toBe("BEARISH");
    expect(confirmedMacroFlipDirection({ ...strongBear, ethTrend: "BULLISH" })).toBeNull();
    expect(confirmedMacroFlipDirection({ ...strongBear, btcAdx: 24 })).toBeNull();
    expect(confirmedMacroFlipDirection({ ...strongBear, btcChange1hPct: -0.1 })).toBeNull();
    expect(confirmedMacroFlipDirection({ ...strongBear, side: "SHORT", btcTrend: "BULLISH", ethTrend: "BULLISH", btcChange1hPct: 0.4 })).toBe("BULLISH");
  });

  it("trend flip harus bertahan pada pembacaan terpisah setidaknya 60 detik", () => {
    const guard = new TrendFlipConfirmationGuard();
    const t0 = 1_700_000_000_000;
    expect(guard.observe("SUIUSDT", "LONG", "BEARISH", t0)).toBe(false);
    expect(guard.observe("SUIUSDT", "LONG", "BEARISH", t0 + 30_000)).toBe(false);
    expect(guard.observe("SUIUSDT", "LONG", "BEARISH", t0 + TREND_FLIP_CONFIRMATION_MIN_MS)).toBe(true);
    // Konfirmasi dikonsumsi; rangkaian baru harus mulai dari awal.
    expect(guard.observe("SUIUSDT", "LONG", "BEARISH", t0 + 90_000)).toBe(false);
  });

  it("membatalkan flip tertunda jika arah kembali netral/searah atau gap terlalu lama", () => {
    const guard = new TrendFlipConfirmationGuard();
    const t0 = 1_700_000_000_000;
    expect(guard.observe("SUIUSDT", "LONG", "BEARISH", t0)).toBe(false);
    expect(guard.observe("SUIUSDT", "LONG", "BULLISH", t0 + 40_000)).toBe(false);
    expect(guard.observe("SUIUSDT", "LONG", "BEARISH", t0 + 80_000)).toBe(false);
    expect(guard.observe("SUIUSDT", "LONG", "BEARISH", t0 + 12 * 60_000)).toBe(false);
  });
});

describe("readTrendWithAgents: LLM baca trend, angka tetap deterministik", () => {
  it("LLM bilang BEARISH kuat -> LONG boleh exit (EXIT_NOW)", async () => {
    const reading = await readTrendWithAgents(baseInput(), async () => "ARAH=BEARISH KEYAKINAN=[85]");
    expect(reading.newTrend).toBe("BEARISH");
    expect(reading.againstPosition).toBe(true);
    expect(reading.strength).toBe("STRONG");
    expect(reading.shouldExit).toBe(true);
    expect(reading.exitUrgency).toBe("EXIT_NOW");
    expect(reading.byLlm).toBe(true);
  });

  it("LLM gagal (error) -> fallback deterministik dari ZLEMA flip", async () => {
    const reading = await readTrendWithAgents(baseInput(), async () => { throw new Error("llm down"); });
    expect(reading.newTrend).toBe("BEARISH");
    expect(reading.shouldExit).toBe(true);
    expect(reading.byLlm).toBe(false);
  });

  it("respons kosong dicatat sebagai fallback, bukan jawaban LLM", async () => {
    const reading = await readTrendWithAgents(baseInput(), async () => "   ");
    expect(reading.byLlm).toBe(false);
    expect(reading.narrative).toContain("baca deterministik");
  });

  it("safety: narasi LLM menyimpang dari ZLEMA kuat -> angka menang", async () => {
    const reading = await readTrendWithAgents(baseInput(), async () => "ARAH=BULLISH KEYAKINAN=[90]");
    expect(reading.newTrend).toBe("BEARISH");
    expect(reading.shouldExit).toBe(true);
  });

  it("trend searah posisi -> HOLD (tidak exit)", async () => {
    const reading = await readTrendWithAgents(
      baseInput({ zlemaDirection: "BULLISH", zlemaIsFlip: false, trendScore: 70, unrealizedNetUsd: 0.5 }),
      async () => "ARAH=BULLISH KEYAKINAN=[70]"
    );
    expect(reading.againstPosition).toBe(false);
    expect(reading.shouldExit).toBe(false);
    expect(reading.exitUrgency).toBe("HOLD");
  });
});

describe("exitOnTrendFlip: close cerdas lewat PositionSupervisor", () => {
  const dummyExecutor = new OrderExecutor({ repo: new DummyOrderRepo(), isArmed: () => false });

  it("TREND_FLIP menutup sisa posisi + jurnal trade + event TREND_FLIP_EXIT", async () => {
    const repo = new MemoryPositionRepo();
    const mockTime = 1700000000000;
    const supervisor = new PositionSupervisor({ repo, executor: dummyExecutor, now: () => mockTime });

    // Model single-target (29 Sep 2026): SL sudah dipindah ke breakeven.
    // originalQty/originalSlPrice/originalRiskUsd wajib diisi persis seperti di
    // plannedEntry.ts — tanpa itu risk accounting exit menolak menutup posisi.
    const qty = 0.002;
    const originalSl = 59400;
    const pos = await repo.createPosition({
      symbol: "BTCUSDT", mode: "SCALP", side: "LONG",
      entryPrice: 60000, qty, notional: 60000 * qty, leverage: 20, marginUsd: 6,
      originalQty: qty, originalSlPrice: originalSl,
      originalRiskUsd: Math.abs(60000 - originalSl) * qty,
      slPrice: 60000, tp1Price: 60600, tp2Price: 61200,
      beMoved: true, tp1FilledAt: new Date(mockTime - 60000), tp2FilledAt: null,
      realizedPnlUsd: 0, tp1FillPrice: 60600,
      status: "OPEN", openedAt: new Date(mockTime - 120000), closedAt: null,
      closeReason: null, pnlUsd: null, pnlR: null, outlookText: "",
    });

    const ok = await supervisor.exitOnTrendFlip(pos.id, 60300, { newTrend: "BEARISH", confidence: 0.8, strength: "STRONG" });
    expect(ok).toBe(true);

    const closed = await repo.findById(pos.id);
    expect(closed?.status).toBe("CLOSED");
    expect(closed?.closeReason).toBe("TREND_FLIP");

    // Net = harga exit di atas entry - fee masuk/keluar (satu target, tanpa runner).
    const trade = repo.getTrade(pos.id);
    expect(trade).toBeDefined();
    expect(trade!.pnlUsd).toBeGreaterThan(0);
    expect(trade!.win).toBe(true);

    const ev = repo.loggedEvents.find((e) => e.action === "TREND_FLIP_EXIT");
    expect(ev).toBeDefined();
    expect(ev?.payload.newTrend).toBe("BEARISH");

    const closedEvent = repo.loggedEvents.find((e) => e.action === "POSITION_CLOSED");
    expect(closedEvent?.payload.closeReason).toBe("TREND_FLIP");
  });

  it("posisi sudah CLOSED -> exitOnTrendFlip aman (false, tidak dobel)", async () => {
    const repo = new MemoryPositionRepo();
    const supervisor = new PositionSupervisor({ repo, executor: dummyExecutor, now: () => 1700000000000 });
    const pos = await repo.createPosition({
      symbol: "ETHUSDT", mode: "SCALP", side: "SHORT",
      entryPrice: 3000, qty: 0.01, notional: 30, leverage: 20, marginUsd: 1.5,
      slPrice: 3030, tp1Price: 2970, tp2Price: 2940,
      beMoved: false, tp1FilledAt: null, tp2FilledAt: null,
      realizedPnlUsd: 0, tp1FillPrice: null,
      status: "CLOSED", openedAt: new Date(1700000000000 - 60000), closedAt: new Date(),
      closeReason: "SL", pnlUsd: -1, pnlR: -1, outlookText: "",
    });
    const ok = await supervisor.exitOnTrendFlip(pos.id, 3050, { newTrend: "BULLISH" });
    expect(ok).toBe(false);
  });
});
