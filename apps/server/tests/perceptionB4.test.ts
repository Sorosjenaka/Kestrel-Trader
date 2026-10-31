// tests/perceptionB4.test.ts — Big Brain Tahap B4 (14 Okt 2026)
// 24 Okt 2026: fungsi-fungsi ini kini mengembalikan STATUS eksplisit
// (value + status + reason) alih-alih `number | null` tanpa alasan, supaya
// UI bisa menampilkan "n/a (alasan)" alih-alih "—" yang ambigu.
import { describe, it, expect, beforeEach } from "vitest";
import {
  fetchOpenInterestChangePct,
  calculateBetaBtc,
  getBtcReferenceBars,
  resetPerceptionCaches,
} from "../src/engines/perceptionB4.js";
import type { Bar } from "../src/universe/eligibility.js";

const bar = (openTime: number, close: number, volume = 1): Bar => ({
  openTime, open: close, high: close, low: close, close, volume,
});

describe("perceptionB4 (Big Brain B4)", () => {
  beforeEach(() => resetPerceptionCaches());

  it("OI change: (last-first)/first dalam %, 2 titik cukup", async () => {
    const fetchPublic = async <T>(): Promise<{ data: T }> => ({
      data: [
        { sumOpenInterest: "100.5", timestamp: 1 },
        { sumOpenInterest: "103.515", timestamp: 2 },
      ] as unknown as T,
    });
    const res = await fetchOpenInterestChangePct("BTCUSDT", fetchPublic);
    expect(res.value).toBeCloseTo(3.0, 6);
    expect(res.status).toBe("OK");
  });

  it("fail-open: fetch gagal / data kurang -> value null + status eksplisit, tidak melempar", async () => {
    const boom = async (): Promise<never> => { throw new Error("net down"); };
    const failed = await fetchOpenInterestChangePct("XUSDT", boom);
    expect(failed.value).toBeNull();
    expect(failed.status).toBe("FETCH_FAILED");
    expect(failed.reason).toBe("OI_FETCH_FAILED");

    const empty = async <T>(): Promise<{ data: T }> => ({ data: [] as unknown as T });
    const noData = await fetchOpenInterestChangePct("YUSDT", empty);
    expect(noData.value).toBeNull();
    expect(noData.status).toBe("NO_DATA");
    expect(noData.reason).toContain("OI_HIST_EMPTY");
  });

  it("OI: error HTTP 404 dinormalisasi jadi OI_FETCH_HTTP_404 (tanpa URL/secret)", async () => {
    const http404 = async (): Promise<never> => {
      throw new Error("RestPool habis percobaan (4x): HTTP 404 dari fapi.binance.com: {}");
    };
    const res = await fetchOpenInterestChangePct("ZZUSDT", http404);
    expect(res.value).toBeNull();
    expect(res.status).toBe("FETCH_FAILED");
    expect(res.reason).toBe("OI_FETCH_HTTP_404");
  });

  it("OI: nilai di-cache (TTL 5 menit) — fetch kedua tidak memanggil jaringan lagi", async () => {
    let calls = 0;
    const fetchPublic = async <T>(): Promise<{ data: T }> => {
      calls++;
      return {
        data: [
          { sumOpenInterest: "100", timestamp: 1 },
          { sumOpenInterest: "110", timestamp: 2 },
        ] as unknown as T,
      };
    };
    const first = await fetchOpenInterestChangePct("CACHEUSDT", fetchPublic);
    const second = await fetchOpenInterestChangePct("CACHEUSDT", fetchPublic);
    expect(first.value).toBeCloseTo(10, 6);
    expect(second.value).toBeCloseTo(10, 6);
    expect(calls).toBe(1);
  });

  it("beta = cov/var terhadap BTC; simbol mengikuti BTC -> ~1", () => {
    // BTC naik-turun teratur; simbol = BTC persis -> beta 1.
    const btc: Bar[] = [];
    for (let i = 0; i < 60; i++) btc.push(bar(i * 300_000, 100 + (i % 2 ? 1 : -1)));
    const same = calculateBetaBtc(btc, btc);
    expect(same.value).toBeCloseTo(1, 6);
    expect(same.status).toBe("OK");
    // Simbol = 2x pergerakan BTC -> beta ~2.
    const amp: Bar[] = btc.map((b, i) => bar(b.openTime, 100 + (i % 2 ? 2 : -2)));
    const doubled = calculateBetaBtc(amp, btc);
    expect(doubled.value).toBeCloseTo(2, 2); // log-return: presisi 2 desimal cukup
    expect(doubled.status).toBe("OK");
  });

  it("beta: bar kurang dari 50 -> null + status INSUFFICIENT_SAMPLES (tanpa fabrikasi)", () => {
    const short: Bar[] = [];
    for (let i = 0; i < 40; i++) short.push(bar(i * 300_000, 100));
    const res = calculateBetaBtc(short, short);
    expect(res.value).toBeNull();
    expect(res.status).toBe("INSUFFICIENT_SAMPLES");
    expect(res.reason).toContain("LT_51");

    const noBtc = calculateBetaBtc(short, null);
    expect(noBtc.value).toBeNull();
    expect(noBtc.status).toBe("FETCH_FAILED");
    expect(noBtc.reason).toBe("BETA_NO_BTC_REFERENCE");
  });

  it("getBtcReferenceBars: <51 bar -> status INSUFFICIENT_SAMPLES dan hasilnya di-cache", async () => {
    let calls = 0;
    const fetchKlines = async (): Promise<unknown[]> => {
      calls++;
      return Array.from({ length: 30 }, (_, i) => [i, "1", "1", "1", "1", "1"]);
    };
    const first = await getBtcReferenceBars(fetchKlines);
    expect(first.bars).toBeNull();
    expect(first.status).toBe("INSUFFICIENT_SAMPLES");
    expect(first.reason).toContain("BTC_REF_BARS_30_LT_51");
    const second = await getBtcReferenceBars(fetchKlines);
    expect(second.bars).toBeNull();
    expect(calls).toBe(1); // cache 60 dtk mencegah fetch ulang
  });

  it("getBtcReferenceBars: bar valid -> dikembalikan sebagai Bar[] dengan status OK", async () => {
    const raw = Array.from({ length: 60 }, (_, i) => [i * 300_000, "100", "101", "99", "100", "5"]);
    const res = await getBtcReferenceBars(async () => raw);
    expect(res.bars).not.toBeNull();
    expect(res.status).toBe("OK");
    expect(res.bars!.length).toBe(60);
    expect(res.bars![0]!.close).toBe(100);
  });

  it("getBtcReferenceBars: fetch melempar -> status FETCH_FAILED (fail-open)", async () => {
    const boom = async (): Promise<never> => { throw new Error("cooldown"); };
    const res = await getBtcReferenceBars(boom);
    expect(res.bars).toBeNull();
    expect(res.status).toBe("FETCH_FAILED");
    expect(res.reason).toBe("BTC_REF_FETCH_FAILED");
  });
});
