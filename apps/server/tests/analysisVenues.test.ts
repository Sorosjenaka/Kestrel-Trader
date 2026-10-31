// apps/server/tests/analysisVenues.test.ts - 23 Okt 2026 (Tahap 4).
// Test per-venue. Fokus: SEMANTIK AGGRESSOR. Salah baca = delta/CVD terbalik.
import { describe, expect, it } from "vitest";
import {
  parseHyperliquidTrades, hyperliquidSubscribePayload, hyperliquidPingPayload,
  hyperliquidCoinToSymbol, parseHyperliquidAssetCtx,
} from "../src/analysis/feeds/hyperliquidTrades.js";
import {
  parseCoinbaseMarketTrades, coinbaseSubscribePayload, aratradeSymbolToCoinbaseProduct,
  parseCoinbaseTime,
} from "../src/analysis/feeds/coinbaseTrades.js";
import { parseBinanceAggTrade } from "../src/analysis/feeds/binanceAggTrade.js";

describe("Hyperliquid PERP", () => {
  it("subscribe message sesuai docs", () => {
    const p = JSON.parse(hyperliquidSubscribePayload("trades", "BTC"));
    expect(p).toEqual({ method: "subscribe", subscription: { type: "trades", coin: "BTC" } });
    expect(JSON.parse(hyperliquidPingPayload())).toEqual({ method: "ping" });
  });

  it('side "B" = agresif BUY (bukan maker side)', () => {
    const raw = JSON.stringify({
      channel: "trades",
      data: [{ coin: "BTC", side: "B", px: "81862.0", sz: "0.00183", time: 1792732642502, hash: "0xabc", tid: 1057214132211309, users: ["0x1", "0x2"] }],
    });
    const t = parseHyperliquidTrades(raw, "BTC")!;
    expect(t).toHaveLength(1);
    expect(t[0]!.aggressor).toBe("BUY");
    expect(t[0]!.price).toBe(81862);
    expect(t[0]!.qty).toBe(0.00183);
    expect(t[0]!.eventTime).toBe(1792732642502);
  });

  it('side "A" = agresif SELL', () => {
    const raw = JSON.stringify({
      channel: "trades",
      data: [{ coin: "BTC", side: "A", px: "81862.0", sz: "1", time: 1792732642502, tid: 1 }],
    });
    expect(parseHyperliquidTrades(raw, "BTC")![0]!.aggressor).toBe("SELL");
  });

  it("bukan channel trades -> null (tidak mengarang tick)", () => {
    expect(parseHyperliquidTrades(JSON.stringify({ channel: "pong" }), "BTC")).toBeNull();
    expect(parseHyperliquidTrades("bukan json", "BTC")).toBeNull();
  });

  it("coin lain diabaikan", () => {
    const raw = JSON.stringify({
      channel: "trades",
      data: [{ coin: "ETH", side: "B", px: "1", sz: "1", time: 1, tid: 1 }],
    });
    expect(parseHyperliquidTrades(raw, "BTC")).toBeNull();
  });

  it("payload rusak -> tick dilewati, bukan crash", () => {
    const raw = JSON.stringify({
      channel: "trades",
      data: [
        { coin: "BTC", side: "X", px: "1", sz: "1", time: 1, tid: 1 }, // side tak dikenal
        { coin: "BTC", side: "B", px: "0", sz: "1", time: 1, tid: 2 },   // harga 0
        { coin: "BTC", side: "B", px: "1", sz: "-1", time: 1, tid: 3 },  // qty negatif
        { coin: "BTC", side: "B", px: "1", sz: "1", time: 1, tid: 4 },   // valid
      ],
    });
    const t = parseHyperliquidTrades(raw, "BTC")!;
    expect(t).toHaveLength(1);
    expect(t[0]!.id).toBe("hl-BTC-4");
  });

  it("simbol ArtaTrade dari coin HL", () => {
    expect(hyperliquidCoinToSymbol("BTC")).toBe("BTCUSDT");
    expect(hyperliquidCoinToSymbol("eth")).toBe("ETHUSDT");
    expect(hyperliquidCoinToSymbol("xyz:XYZ100")).toBe("XYZ100USDT");
  });

  it("ctx aset: funding/OI/markPx terbaca, yang hilang tetap null", () => {
    // Bentuk nyata dari server HL (terverifikasi live 23 Okt 2026):
    // ctx berada DI DALAM `data`, bukan di root.
    const raw = JSON.stringify({
      channel: "activeAssetCtx",
      data: {
        coin: "BTC",
        ctx: { funding: "0.0000125", openInterest: "43857.02194", markPx: "81804.0", midPx: "81800.5", oraclePx: "81800.0", premium: "0.0", dayNtlVlm: "3089764540.49" },
      },
    });
    const c = parseHyperliquidAssetCtx(raw, "BTC")!;
    expect(c).not.toBeNull();
    expect(c.coin).toBe("BTC");
    expect(c.funding).toBeCloseTo(0.0000125, 10);
    expect(c.openInterest).toBeCloseTo(43857.02194, 6);
    expect(c.markPx).toBe(81804);
    expect(c.midPx).toBe(81800.5);
    expect(c.oraclePx).toBe(81800);
  });

  it("ctx tanpa field -> null (bukan 0 palsu)", () => {
    const raw = JSON.stringify({ channel: "activeAssetCtx", data: { coin: "BTC", ctx: { coin: "BTC" } } });
    const c = parseHyperliquidAssetCtx(raw, "BTC")!;
    expect(c.funding).toBeNull();
    expect(c.openInterest).toBeNull();
    expect(c.markPx).toBeNull();
  });

  it("ctx tanpa field -> null (bukan 0 palsu) [bentuk lama tetap ditolak]", () => {
    const raw = JSON.stringify({ channel: "activeAssetCtx", ctx: { coin: "BTC" } });
    expect(parseHyperliquidAssetCtx(raw, "BTC")).toBeNull();
  });
});

describe("Coinbase SPOT — SEMANTIK MAKER SIDE", () => {
  it("subscribe message sesuai docs", () => {
    const p = JSON.parse(coinbaseSubscribePayload("BTC-USD"));
    expect(p).toEqual({ type: "subscribe", channel: "market_trades", product_ids: ["BTC-USD"] });
  });

  it("produk BTCUSDT -> BTC-USD", () => {
    expect(aratradeSymbolToCoinbaseProduct("BTCUSDT")).toBe("BTC-USD");
    expect(aratradeSymbolToCoinbaseProduct("ETHUSDT")).toBe("ETH-USD");
  });

  it("maker side SELL -> taker BUY (DIBALIK)", () => {
    // Docs: MarketTrade.side = "The maker's side of the trade."
    // Kalau tidak dibalik, delta/CVD Coinbase terbalik 100%.
    const raw = JSON.stringify({
      channel: "market_trades",
      timestamp: "2026-10-23T05:17:27.950329875Z",
      sequence_num: 1,
      events: [{ type: "update", trades: [{ product_id: "BTC-USD", trade_id: "1109661593", price: "81748.54", size: "0.00439761", time: "2026-10-23T05:17:49.248363Z", side: "SELL" }] }],
    });
    const t = parseCoinbaseMarketTrades(raw, "BTC-USD")!;
    expect(t).toHaveLength(1);
    expect(t[0]!.aggressor).toBe("BUY");
    expect(t[0]!.price).toBe(81748.54);
    expect(t[0]!.qty).toBe(0.00439761);
  });

  it("maker side BUY -> taker SELL (DIBALIK)", () => {
    const raw = JSON.stringify({
      channel: "market_trades",
      events: [{ type: "update", trades: [{ product_id: "BTC-USD", trade_id: "9", price: "1", size: "1", time: "2026-10-23T05:17:49.248363Z", side: "BUY" }] }],
    });
    expect(parseCoinbaseMarketTrades(raw, "BTC-USD")![0]!.aggressor).toBe("SELL");
  });

  it("snapshot event juga diparse", () => {
    const raw = JSON.stringify({
      channel: "market_trades",
      events: [{ type: "snapshot", trades: [{ product_id: "BTC-USD", trade_id: "1", price: "1", size: "1", time: "2026-10-23T05:17:49.248363Z", side: "SELL" }] }],
    });
    expect(parseCoinbaseMarketTrades(raw, "BTC-USD")).toHaveLength(1);
  });

  it("produk lain & payload rusak -> null", () => {
    const other = JSON.stringify({
      channel: "market_trades",
      events: [{ type: "update", trades: [{ product_id: "ETH-USD", trade_id: "1", price: "1", size: "1", time: "2026-10-23T05:17:49.248363Z", side: "SELL" }] }],
    });
    expect(parseCoinbaseMarketTrades(other, "BTC-USD")).toBeNull();
    expect(parseCoinbaseMarketTrades("bukan json", "BTC-USD")).toBeNull();
    expect(parseCoinbaseMarketTrades(JSON.stringify({ channel: "ticker" }), "BTC-USD")).toBeNull();
  });

  it("timestamp mikrodetik dipotong ke ms; yang rusak -> null", () => {
    expect(parseCoinbaseTime("2026-10-23T05:17:49.248363Z")).toBe(Date.parse("2026-10-23T05:17:49.248Z"));
    expect(parseCoinbaseTime("bukan tanggal")).toBeNull();
    expect(parseCoinbaseTime(undefined)).toBeNull();
  });
});

describe("konsistensi lintas venue — agresor WAJIB sebanding", () => {
  it("ketiga venue memakai definisi agresor yang sama (taker/aggressor)", () => {
    // 1 tick, 1 qi: seller agresif 1 unit pada harga 100.
    // Binance: m=true (buyer maker) -> agresif SELL.
    const bin = parseBinanceAggTrade(JSON.stringify({ e: "aggTrade", E: 1, s: "BTCUSDT", a: 1, p: "100", q: "1", m: true, T: 1 }), "BTCUSDT")!;
    expect(bin.tick.aggressor).toBe("SELL");

    // Hyperliquid: side "A" -> agresif SELL.
    const hl = parseHyperliquidTrades(JSON.stringify({ channel: "trades", data: [{ coin: "BTC", side: "A", px: "100", sz: "1", time: 1, tid: 1 }] }), "BTC")!;
    expect(hl[0]!.aggressor).toBe("SELL");

    // Coinbase: maker side "BUY" -> agresif SELL (taker-nya yang beli maker itu jual).
    const cb = parseCoinbaseMarketTrades(JSON.stringify({
      channel: "market_trades",
      events: [{ type: "update", trades: [{ product_id: "BTC-USD", trade_id: "1", price: "100", size: "1", time: "2026-10-23T05:17:49.248363Z", side: "BUY" }] }],
    }), "BTC-USD")!;
    expect(cb[0]!.aggressor).toBe("SELL");

    // Ketiganya SELL -> bisa dijumlahkan tanpa pembalikan tersembunyi.
    expect(new Set([bin.tick.aggressor, hl[0]!.aggressor, cb[0]!.aggressor]).size).toBe(1);
  });
});
