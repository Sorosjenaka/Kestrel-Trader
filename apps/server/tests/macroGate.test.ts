import { describe, it, expect } from "vitest";
import { Bar } from "../src/universe/eligibility.js";
import {
  evaluateMacroGate,
  MacroGateKeeper,
  MACRO_REASON_BTC_BEARISH,
  MACRO_REASON_BTC_BULLISH,
  MACRO_REASON_BTC_VOLATILE,
  MACRO_REASON_ETH_BEARISH,
  MACRO_REASON_BTCDOM_SPIKE,
  MACRO_KLINE_LIMIT,
  analyzeMacroSymbol,
} from "../src/engines/macroGate.js";

function makeSyntheticBars(
  count: number,
  startPrice = 60000,
  step = 50,
  noise = 10
): Bar[] {
  const bars: Bar[] = [];
  let price = startPrice;
  const baseTime = 1700000000000;

  for (let i = 0; i < count; i++) {
    const open = price;
    const close = price + step + (i % 2 === 0 ? noise : -noise);
    const high = Math.max(open, close) + noise * 1.5;
    const low = Math.min(open, close) - noise * 1.5;
    const volume = 5000 + i * 100;

    bars.push({
      openTime: baseTime + i * 3600000, // 1h bar
      open: Number(open.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      close: Number(close.toFixed(2)),
      volume,
    });

    price = close;
  }
  return bars;
}

describe("FR-05 & FR-06: Gate Makro BTC/ETH & BTCDOMUSDT", () => {
  it("FR-05 (AC-05): Memblokir LONG pada alt saat tren 1h BTC menurun kuat", () => {
    // 40 bar BTC tren turun tajam: step = -200
    const btcBars = makeSyntheticBars(40, 65000, -200, 20);
    // ETH flat
    const ethBars = makeSyntheticBars(40, 3500, 0, 5);
    // BTCDOM flat
    const btcDomBars = makeSyntheticBars(40, 55, 0, 0.05);

    const res = evaluateMacroGate("SOLUSDT", "LONG", {
      btcBars1h: btcBars,
      ethBars1h: ethBars,
      btcdomBars1h: btcDomBars,
    });

    expect(res.pass).toBe(false);
    expect(res.blockedReasons).toContain(MACRO_REASON_BTC_BEARISH);
  });

  it("FR-05: Memblokir SHORT pada alt saat tren 1h BTC naik kuat", () => {    // 40 bar BTC tren naik kuat: step = +200
    const btcBars = makeSyntheticBars(40, 60000, 200, 20);
    const ethBars = makeSyntheticBars(40, 3000, 0, 5);
    const btcDomBars = makeSyntheticBars(40, 55, 0, 0.05);

    const res = evaluateMacroGate("SOLUSDT", "SHORT", {
      btcBars1h: btcBars,
      ethBars1h: ethBars,
      btcdomBars1h: btcDomBars,
    });

    expect(res.pass).toBe(false);
    expect(res.blockedReasons).toContain(MACRO_REASON_BTC_BULLISH);
  });

  it("FR-05: Memblokir semua entry saat BTC mengalami volatilitas ekstrim (ATR spike)", () => {
    // 80 bar stabil + 5 bar volatilitas sangat ekstrim
    const base = makeSyntheticBars(80, 60000, 0, 50);
    const spike = makeSyntheticBars(5, 60000, 1000, 2500);
    const btcBars = [...base, ...spike];

    const ethBars = makeSyntheticBars(40, 3000, 0, 5);
    const btcDomBars = makeSyntheticBars(40, 55, 0, 0.05);

    const res = evaluateMacroGate("SOLUSDT", "LONG", {
      btcBars1h: btcBars,
      ethBars1h: ethBars,
      btcdomBars1h: btcDomBars,
    });

    expect(res.pass).toBe(false);
    expect(res.blockedReasons).toContain(MACRO_REASON_BTC_VOLATILE);
  });

  it("FR-05: Memblokir LONG saat ETH tren turun tajam dan drop > 0.5%", () => {
    const btcBars = makeSyntheticBars(40, 60000, 0, 20); // BTC netral
    const ethBars = makeSyntheticBars(40, 3000, -20, 5); // ETH drop tajam
    const btcDomBars = makeSyntheticBars(40, 55, 0, 0.05);

    const res = evaluateMacroGate("SOLUSDT", "LONG", {
      btcBars1h: btcBars,
      ethBars1h: ethBars,
      btcdomBars1h: btcDomBars,
    });

    expect(res.pass).toBe(false);
    expect(res.blockedReasons).toContain(MACRO_REASON_ETH_BEARISH);
  });

  it("FR-06: lonjakan BTC.D memblokir LONG alt, tidak otomatis memblokir SHORT", () => {
    const btcBars = makeSyntheticBars(40, 60000, 0, 10);
    const ethBars = makeSyntheticBars(40, 3000, 0, 5);

    // 39 bar stabil di 55.0, bar terakhir melonjak ke 55.5 (+0.9%)
    const btcDomBars = makeSyntheticBars(39, 55, 0, 0.02);
    btcDomBars.push({
      openTime: 1700000000000 + 39 * 3600000,
      open: 55.0,
      high: 55.6,
      low: 55.0,
      close: 55.5,
      volume: 10000,
    });

    // Altcoin (SOLUSDT) HARUS diblokir
    const resAlt = evaluateMacroGate("SOLUSDT", "LONG", {
      btcBars1h: btcBars,
      ethBars1h: ethBars,
      btcdomBars1h: btcDomBars,
    });
    expect(resAlt.pass).toBe(false);
    expect(resAlt.blockedReasons).toContain(MACRO_REASON_BTCDOM_SPIKE);
    const shortAlt = evaluateMacroGate("SOLUSDT", "SHORT", {
      btcBars1h: btcBars, ethBars1h: ethBars, btcdomBars1h: btcDomBars,
    });
    expect(shortAlt.blockedReasons).not.toContain(MACRO_REASON_BTCDOM_SPIKE);

    // Simbol BTCUSDT sendiri TIDAK diblokir oleh lonjakan dominasi BTC
    const resBtc = evaluateMacroGate("BTCUSDT", "LONG", {
      btcBars1h: btcBars,
      ethBars1h: ethBars,
      btcdomBars1h: btcDomBars,
    });
    expect(resBtc.blockedReasons).not.toContain(MACRO_REASON_BTCDOM_SPIKE);
  });

  it("Meloloskan kandidat saat semua kondisi makro kondusif", () => {
    // BTC dan ETH stabil / sedikit naik searah dengan posisi LONG
    const btcBars = makeSyntheticBars(40, 60000, 15, 10);
    const ethBars = makeSyntheticBars(40, 3000, 2, 2);
    const btcDomBars = makeSyntheticBars(40, 55, 0, 0.02);

    const res = evaluateMacroGate("SOLUSDT", "LONG", {
      btcBars1h: btcBars,
      ethBars1h: ethBars,
      btcdomBars1h: btcDomBars,
    });

    expect(res.pass).toBe(true);
    expect(res.blockedReasons.length).toBe(0);
  });

  it("MacroGateKeeper mengelola snapshot dan mengevaluasi kandidat secara real-time", () => {    const keeper = new MacroGateKeeper();
    const btcBars = makeSyntheticBars(40, 60000, 10, 5);
    const ethBars = makeSyntheticBars(40, 3000, 1, 2);
    const btcDomBars = makeSyntheticBars(40, 55, 0, 0.02);

    keeper.updateSnapshot({ btcBars1h: btcBars, ethBars1h: ethBars, btcdomBars1h: btcDomBars });
    const res = keeper.evaluate("NEARUSDT", "LONG");

    expect(res).toHaveProperty("pass");
    expect(res.btc.symbol).toBe("BTCUSDT");
    expect(res.eth.symbol).toBe("ETHUSDT");
  });

  it("SHORT ditolak saat BTC bullish, tetapi BTC netral tidak memveto pair bearish", () => {
    const ethBars = makeSyntheticBars(40, 3000, 0, 5);
    const btcDomBars = makeSyntheticBars(40, 55, 0, 0.02);

    // BTC grind naik (tidak kuat) — SHORT tetap diblokir
    const btcUp = makeSyntheticBars(40, 60000, 15, 10);
    const blocked = evaluateMacroGate("SOLUSDT", "SHORT", {
      btcBars1h: btcUp,
      ethBars1h: ethBars,
      btcdomBars1h: btcDomBars,
    });
    expect(blocked.pass).toBe(false);
    expect(blocked.blockedReasons).toContain(MACRO_REASON_BTC_BULLISH);

    // BTC bearish jelas — SHORT diizinkan (gate lain lolos)
    const btcDown = makeSyntheticBars(40, 65000, -200, 20);
    const allowed = evaluateMacroGate("SOLUSDT", "SHORT", {
      btcBars1h: btcDown,
      ethBars1h: ethBars,
      btcdomBars1h: btcDomBars,
    });
    expect(allowed.blockedReasons).not.toContain(MACRO_REASON_BTC_BULLISH);
    expect(allowed.pass).toBe(true);

    // Sebelum perbaikan fetch makro hanya 30 bar: ZLEMA(21) belum cukup warm-up.
    expect(analyzeMacroSymbol("BTCUSDT", btcDown.slice(-30)).trendDirection).toBe("NEUTRAL");
    expect(MACRO_KLINE_LIMIT).toBeGreaterThanOrEqual(31);
    expect(analyzeMacroSymbol("BTCUSDT", makeSyntheticBars(MACRO_KLINE_LIMIT, 65000, -200, 20)).trendDirection).toBe("BEARISH");
    const neutralBtc = evaluateMacroGate("SOLUSDT", "SHORT", {
      btcBars1h: btcDown.slice(-30), ethBars1h: ethBars, btcdomBars1h: btcDomBars,
    });
    expect(neutralBtc.blockedReasons).not.toContain(MACRO_REASON_BTC_BULLISH);
  });
});
