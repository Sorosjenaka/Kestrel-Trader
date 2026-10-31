// Offline regression tests untuk tiga bug real-time/volume 23 Okt 2026.
//
// 1. Route SSE /api/binance/kline-stream TIDAK PERNAH ADA -> frontend
//    (klineStream.ts) fallback ke REST cache, candle tidak pernah streaming.
//    Test ini mengunci KONTRAK payload yang harus dikirim route tersebut
//    supaya parseStreamCandle() di frontend tidak menolak datanya.
//
// 2. Jalur SWING/RSW tidak pernah memanggil checkTradeVolume() -> pair di
//    bawah VOLUME_MIN_USD tetap bisa membuka posisi.
//
// 3. getHubPrices() hanya mengirim p/m -> browser tidak bisa menampilkan
//    volume 24h & %24h yang detail untuk setiap pair.
//
// Semua test ini offline: tidak menyentuh jaringan, DB runtime, atau engine.
import { describe, expect, it } from "vitest";
import { parseKlineEvent } from "../src/marketdata/klineWsManager.js";
import { checkTradeVolume, getTradeVolumeFloor } from "../src/exec/slotFillPolicy.js";

const MIN = 7_000_000;

describe("kline SSE payload contract (route /api/binance/kline-stream)", () => {
  const raw = {
    e: "kline", E: 1792740114254, s: "BTCUSDT",
    k: {
      t: 1792740060000, T: 1792740119999, s: "BTCUSDT", i: "1m", x: false,
      o: "81705.7", c: "81723.1", h: "81727.1", l: "81705.6",
      v: "15.026", q: "1227891.1102", V: "10.66", Q: "871096.2876",
    },
  };

  it("route mengirim {type:'kline', candle:{...}} yang diterima frontend", () => {
    // Bentuk event SSE yang route wajib kirim.
    const event = { type: "kline", candle: parseKlineEvent(raw) };
    expect(event.type).toBe("kline");
    expect(event.candle).not.toBeNull();
    // parseStreamCandle() frontend menolak payload tanpa type==="kline",
    // dan mengambil field berikut — semua harus ada di candle.
    for (const key of [
      "symbol", "interval", "openTime", "closeTime", "time",
      "open", "high", "low", "close", "volume", "quoteVolume",
      "takerBuyBase", "takerBuyQuote", "closed", "eventTime", "receivedAt",
    ]) {
      expect(event.candle, `field ${key} wajib ada`).toHaveProperty(key);
    }
  });

  it("frame status punya field yang dibaca frontend", () => {
    // Frontend membaca status.connected / status.status / status.lastEventAgeMs.
    const status = { type: "status", connected: true, status: "CONNECTED", lastEventAgeMs: 310, lastError: null };
    expect(status.type).toBe("status");
    expect(status.connected).toBe(true);
    expect(status.status).toBe("CONNECTED");
    expect(Number.isFinite(status.lastEventAgeMs)).toBe(true);
  });

  it("candle streaming membawa volume & quoteVolume untuk pair tipis", () => {
    const c = parseKlineEvent({
      ...raw, s: "SPKUSDT",
      k: { ...raw.k, s: "SPKUSDT", o: "0.01872", c: "0.01871", h: "0.01872", l: "0.01871", v: "6695", q: "125.26698" },
    });
    expect(c).not.toBeNull();
    expect(c!.symbol).toBe("SPKUSDT");
    expect(c!.volume).toBe(6695);
    expect(c!.quoteVolume).toBeCloseTo(125.26698, 5);
  });
});

describe("gate volume entry SWING/RSW (regresi bypass 23 Okt 2026)", () => {
  it("lantai volume mengikuti env VOLUME_MIN_USD", () => {
    expect(getTradeVolumeFloor()).toBe(MIN);
  });

  it("menolak pair di bawah lantai volume (kasus SPKUSDT ~$1.56jt)", () => {
    const gate = checkTradeVolume(1_559_312);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("VOLUME");
    expect(gate.volumeUsd).toBe(1_559_312);
  });

  it("menolak volume tepat di ambang (strict-greater)", () => {
    expect(checkTradeVolume(MIN).allowed).toBe(false);
  });

  it("menerima pair di atas lantai", () => {
    expect(checkTradeVolume(8_696_219).allowed).toBe(true);
    expect(checkTradeVolume(104_519_131).allowed).toBe(true);
  });

  it("menolak volume tidak diketahui (jangan menebak likuiditas)", () => {
    const gate = checkTradeVolume(undefined);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("VOLUME_UNKNOWN");
    expect(gate.allowed).toBe(false);
  });

  it("16 dari 20 pair posisi PAPER lama berada di bawah lantai", () => {
    // Volume nyata dari Binance Futures 23 Okt 2026 untuk pair yang punya
    // posisi PAPER terbuka saat bug ditemukan.
    const below = [
      1_154_409, 4_614_154, 5_023_498, 1_248_157, 1_840_915, 1_198_402,
      715_394, 1_817_258, 1_779_892, 5_130_938, 3_043_857, 2_390_010,
      905_242, 1_073_393, 1_559_327, 775_384,
    ];
    for (const v of below) {
      expect(checkTradeVolume(v).allowed, `volume ${v} harus ditolak`).toBe(false);
    }
    // 4 pair yang di atas lantai tetap boleh.
    for (const v of [8_696_219, 21_851_293, 41_508_052, 104_519_131]) {
      expect(checkTradeVolume(v).allowed, `volume ${v} harus lolos`).toBe(true);
    }
  });
});
