// apps/server/src/marketdata/eventTime.test.ts
// 25 Okt 2026 — regression test untuk normalisasi waktu event lintas bursa.
//
// KONTEKS (bug nyata, terbukti live 25 Okt 2026):
//   KuCoin /market/match mengirim timestamp dalam NANOsecond
//   ("1792902798229000000"), sementara semua bursa lain memakai millisecond.
//   Parser lama melakukan `Number(r.time)` tanpa mendeteksi satuan, sehingga:
//
//     1. priceHistory.push() menerima t=1.79e18 ms -> `lastSampleSec`
//        terkunci di masa depan -> SEMUA transaksi nyata berikutnya diabaikan
//        -> priceSeries ke browser kosong, priceChangePct 15M == 1H.
//     2. TimeRing menerima epoch-detik ~1.8e15 -> notional + jumlah trade
//        venue itu terhitung di SETIAP window (1M/5M/15M/1H) sekaligus.
//     3. Seri CVD per venue memuat titik bertimestamp 1.79e15 -> sumbu X
//        chart meledak.
//
// Test ini mengunci INVARIAN normalisasi:
//   1) Deteksi satuan: ns/us/ms/s + ISO-8601.
//   2) Nilai ns dikonversi ke ms yang benar (1e6 pengali).
//   3) Pagar rentang: masa depan jauh & terlalu lama DITOLAK (t=null).
//   4) Missing/unparseable -> t=null tapi outOfRange=false (bukan error waktu).
//   5) Parser venue produksi memakai normalisasi (KuCoin ns -> ms).
//
// CATATAN: `NOW` di bawah = epoch-ms dari probe live (2026-10-25 ~04:32 UTC).
// Semua nilai timestamp di test diturunkan dari NOW agar konsisten dengan
// pagar rentang 6 jam ke belakang.

import { describe, expect, it } from "vitest";
import { detectEpochUnit, normalizeEventTime, MAX_FUTURE_SKEW_MS } from "./eventTime.js";
import {
  parseKucoinTrades,
  parseBinanceAggTrade,
  parseCoinbaseMatches,
  parseHyperliquidTrades,
  parseGateTrades,
  parseOkxTrades,
  parseBitgetTrades,
  parseBybitTrades,
} from "./multiVenueOrderFlowHub.js";

/** Epoch-ms acuan (probe live 25 Okt 2026). */
const NOW = 1_792_902_798_229;
/** Versi nanosecond dari NOW (meniru payload KuCoin). */
const NOW_NS = NOW * 1e6;

describe("eventTime — deteksi satuan epoch", () => {
  it("mengenali nanosecond / microsecond / millisecond / second", () => {
    expect(detectEpochUnit(1_792_902_798_229_000_000)).toBe("ns");
    expect(detectEpochUnit(1_792_902_798_229_000)).toBe("us");
    expect(detectEpochUnit(1_792_902_798_229)).toBe("ms");
    expect(detectEpochUnit(1_792_902_798)).toBe("s");
    expect(detectEpochUnit(123)).toBeNull();
  });

  it("konversi nanosecond ke millisecond yang benar", () => {
    const r = normalizeEventTime(String(NOW_NS), NOW);
    expect(r.t).toBe(NOW);
    expect(r.unitAdjusted).toBe(true);
    expect(r.outOfRange).toBe(false);
  });

  it("konversi microsecond ke millisecond", () => {
    const r = normalizeEventTime(NOW * 1e3, NOW);
    expect(r.t).toBe(NOW);
    expect(r.unitAdjusted).toBe(true);
  });

  it("konversi second ke millisecond", () => {
    const r = normalizeEventTime(Math.floor(NOW / 1000), NOW);
    expect(r.t).toBe(Math.floor(NOW / 1000) * 1000);
    expect(r.unitAdjusted).toBe(true);
  });

  it("millisecond dipakai apa adanya (unitAdjusted=false)", () => {
    const r = normalizeEventTime(NOW, NOW);
    expect(r.t).toBe(NOW);
    expect(r.unitAdjusted).toBe(false);
  });

  it("ISO-8601 diparse (Coinbase)", () => {
    const iso = new Date(NOW).toISOString();
    const r = normalizeEventTime(iso, NOW);
    expect(r.t).toBe(NOW);
    expect(r.outOfRange).toBe(false);
  });
});

describe("eventTime — pagar rentang (anti lock buffer)", () => {
  it("tolak timestamp jauh di masa depan", () => {
    // 1 jam ke depan dalam nanosecond -> masih "ns", tapi 1 jam > pagar 90 dtk.
    const r = normalizeEventTime(String((NOW + 3_600_000) * 1e6), NOW);
    expect(r.t).toBeNull();
    expect(r.outOfRange).toBe(true);
    expect(r.reason).toBe("FUTURE");
  });

  it("tolak timestamp terlalu lama (lebih dari 6 jam)", () => {
    const r = normalizeEventTime(NOW - 7 * 3600_000, NOW);
    expect(r.t).toBeNull();
    expect(r.outOfRange).toBe(true);
    expect(r.reason).toBe("TOO_OLD");
  });

  it("terima skew kecil ke masa depan (drift bursa wajar)", () => {
    const r = normalizeEventTime(NOW + 30_000, NOW);
    expect(r.t).toBe(NOW + 30_000);
    expect(r.outOfRange).toBe(false);
  });

  it("missing / unparseable: t=null tapi BUKAN outOfRange", () => {
    for (const raw of [null, undefined, "", "bukan-angka"]) {
      const r = normalizeEventTime(raw, NOW);
      expect(r.t).toBeNull();
      expect(r.outOfRange).toBe(false);
    }
  });

  it("toleransi masa depan adalah 90 detik", () => {
    expect(MAX_FUTURE_SKEW_MS).toBe(90_000);
  });
});

describe("parser venue produksi memakai normalisasi waktu", () => {
  it("KuCoin nanosecond -> epoch-ms (bukan 1e6x)", () => {
    const msg = {
      type: "message",
      topic: "/market/match:BTC-USDT",
      data: { symbol: "BTC-USDT", side: "buy", price: "80000", size: "0.01", time: String(NOW_NS) },
    };
    const out = parseKucoinTrades(msg, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]!.time).toBe(NOW);
  });

  it("KuCoin nanosecond di luar rentang -> time=-1 (penanda buang)", () => {
    const msg = {
      type: "message",
      topic: "/market/match:BTC-USDT",
      data: { symbol: "BTC-USDT", side: "buy", price: "80000", size: "0.01", time: String(NOW_NS) },
    };
    // `now` 7 jam di belakang -> ns-nya jadi "terlalu lama".
    const out = parseKucoinTrades(msg, NOW - 7 * 3600_000);
    expect(out[0]!.time).toBe(-1);
  });

  it("Binance millisecond tidak berubah", () => {
    const out = parseBinanceAggTrade(
      { e: "aggTrade", s: "BTCUSDT", p: "80000", q: "0.01", m: false, T: NOW },
      "BINANCE_PERP",
      NOW,
    );
    expect(out[0]!.time).toBe(NOW);
  });

  it("Coinbase ISO-8601 diparse ke epoch-ms", () => {
    const out = parseCoinbaseMatches(
      { type: "match", product_id: "BTC-USD", price: "80000", size: "0.01", side: "sell", time: new Date(NOW).toISOString() },
      NOW,
    );
    expect(out[0]!.time).toBe(NOW);
  });

  it("Hyperliquid millisecond tidak berubah", () => {
    const out = parseHyperliquidTrades(
      { channel: "trades", data: [{ coin: "BTC", side: "B", px: "80000", sz: "0.01", time: NOW }] },
      NOW,
    );
    expect(out[0]!.time).toBe(NOW);
  });

  it("Gate / OKX / Bitget / Bybit millisecond tidak berubah", () => {
    const gate = parseGateTrades(
      { channel: "spot.trades", result: { currency_pair: "BTC_USDT", side: "buy", price: "80000", amount: "0.01", create_time_ms: "1792902798229.298" } },
      NOW,
    );
    expect(gate[0]!.time).toBeCloseTo(1_792_902_798_229, 0);

    const okx = parseOkxTrades(
      { data: [{ instId: "BTC-USDT", side: "buy", px: "80000", sz: "0.01", ts: "1792902798229" }] },
      NOW,
    );
    expect(okx[0]!.time).toBe(1_792_902_798_229);

    const bitget = parseBitgetTrades(
      { data: [{ instId: "BTCUSDT", side: "buy", price: "80000", size: "0.01", ts: "1792902798229" }] },
      NOW,
    );
    expect(bitget[0]!.time).toBe(1_792_902_798_229);

    const bybit = parseBybitTrades(
      { type: "snapshot", data: [{ s: "BTCUSDT", p: "80000", v: "0.01", S: "Buy", T: "1792902798229" }] },
      NOW,
    );
    expect(bybit[0]!.time).toBe(1_792_902_798_229);
  });
});
