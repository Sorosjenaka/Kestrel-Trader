// apps/server/tests/liquidationMapHub.test.ts
// Parser Vike (Modul 3 — Liquidation Map): parsing bin heatmap, parsing
// posisi terbuka, resample ke grid ±15%, dan klasifikasi kegagalan.
//
// CATATAN ATURAN MUTLAK: fixture di file TEST ini hanya untuk menguji fungsi
// parser. Tidak ada data mock/random yang masuk ke jalur produksi.
import { describe, expect, it } from "vitest";
import {
  baseCoin,
  classifyVikeFailure,
  parseVikeHeatmap,
  parseVikePositions,
  resampleBins,
} from "../src/marketdata/liquidationMapHub.js";

const MARK = 80_000;

describe("parseVikeHeatmap", () => {
  it("membaca baris heatmap dan mengurutkan naik menurut harga", () => {
    const r = parseVikeHeatmap(
      { bins: [
        { price: 81_000, longUsd: 500_000, shortUsd: 0 },
        { price: 79_000, longUsd: 0, shortUsd: 250_000 },
      ] },
      MARK,
    );
    expect(r.bins.map((b) => b.price)).toEqual([79_000, 81_000]);
    expect(r.bins[0]!.shortUsd).toBe(250_000);
    expect(r.bins[1]!.longUsd).toBe(500_000);
  });

  it("baris tanpa harga valid dibuang (tidak ada angka karangan)", () => {
    const r = parseVikeHeatmap({ bins: [{ price: 0, longUsd: 9 }, { longUsd: 9 }] }, MARK);
    expect(r.bins).toHaveLength(0);
  });

  it("payload berbentuk array polos juga diterima", () => {
    const r = parseVikeHeatmap([{ price: 80_000, longUsd: 1 }], MARK);
    expect(r.bins).toHaveLength(1);
  });
});

describe("resampleBins", () => {
  it("menghasilkan 30 bin seragam di sekitar mark dan mengagregasi notional", () => {
    const out = resampleBins(
      [{ price: 80_000, longUsd: 1_000, shortUsd: 0, distPct: 0 }],
      MARK,
    );
    expect(out).toHaveLength(30);
    // Grid ±15% dari mark 80.000 → 68.000..92.000, lebar bin 24.000/30 = 800.
    expect(out[0]!.price).toBeCloseTo(68_000 + 400, 6);
    expect(out[29]!.price).toBeCloseTo(92_000 - 400, 6);
    const totalLong = out.reduce((a, b) => a + b.longUsd, 0);
    expect(totalLong).toBe(1_000);
  });

  it("bin di luar rentang ±15% dibuang", () => {
    const out = resampleBins(
      [
        { price: 80_000, longUsd: 100, shortUsd: 0, distPct: 0 },
        { price: 200_000, longUsd: 999, shortUsd: 0, distPct: 150 },
      ],
      MARK,
    );
    expect(out.reduce((a, b) => a + b.longUsd, 0)).toBe(100);
  });

  it("tanpa mark price, bin sumber dikembalikan apa adanya", () => {
    const src = [{ price: 80_000, longUsd: 5, shortUsd: 0, distPct: 1 }];
    expect(resampleBins(src, null)).toBe(src);
  });
});

describe("parseVikePositions", () => {
  it("membaca posisi long/short, memisahkan notional per sisi", () => {
    const r = parseVikePositions(
      { positions: [
        { symbol: "BTC", side: "long", liquidationPrice: 79_000, sizeUsd: 300_000 },
        { symbol: "BTC", side: "short", liquidationPrice: 81_000, sizeUsd: 120_000 },
      ] },
      "BTC",
      MARK,
    );
    expect(r.openPositions).toBe(2);
    expect(r.openValueUsd).toBe(420_000);
    const longTotal = r.bins.reduce((a, b) => a + b.longUsd, 0);
    const shortTotal = r.bins.reduce((a, b) => a + b.shortUsd, 0);
    expect(longTotal).toBe(300_000);
    expect(shortTotal).toBe(120_000);
  });

  it("posisi simbol lain dibuang", () => {
    const r = parseVikePositions(
      { positions: [
        { symbol: "ETH", side: "long", liquidationPrice: 79_000, sizeUsd: 300_000 },
        { symbol: "BTC", side: "long", liquidationPrice: 78_000, sizeUsd: 50_000 },
      ] },
      "BTC",
      MARK,
    );
    expect(r.openPositions).toBe(1);
    expect(r.openValueUsd).toBe(50_000);
  });

  it("posisi tanpa harga likuidasi dibuang", () => {
    const r = parseVikePositions(
      { positions: [{ symbol: "BTC", side: "long", sizeUsd: 300_000 }] },
      "BTC",
      MARK,
    );
    expect(r.openPositions).toBeNull();
    expect(r.openValueUsd).toBeNull();
  });

  it("posisi tanpa notional USD dihitung terpisah, bukan jadi nol palsu", () => {
    const r = parseVikePositions(
      { positions: [{ symbol: "BTC", side: "long", liquidationPrice: 79_000 }] },
      "BTC",
      MARK,
    );
    expect(r.levelsWithoutNotional).toBe(1);
    expect(r.openPositions).toBeNull();
    expect(r.bins.every((b) => b.longUsd === 0 && b.shortUsd === 0)).toBe(true);
  });

  it("sisi dari tanda ukuran (szi) dipakai saat field sisi kosong", () => {
    const r = parseVikePositions(
      { positions: [
        { symbol: "BTC", szi: 2.5, liquidationPrice: 79_000, sizeUsd: 10_000 },
        { symbol: "BTC", szi: -1.5, liquidationPrice: 81_000, sizeUsd: 20_000 },
      ] },
      "BTC",
      MARK,
    );
    expect(r.bins.reduce((a, b) => a + b.longUsd, 0)).toBe(10_000);
    expect(r.bins.reduce((a, b) => a + b.shortUsd, 0)).toBe(20_000);
  });

  it("sisi yang tidak bisa dipastikan → baris dibuang", () => {
    const r = parseVikePositions(
      { positions: [{ symbol: "BTC", liquidationPrice: 79_000, sizeUsd: 10_000 }] },
      "BTC",
      MARK,
    );
    expect(r.openPositions).toBeNull();
  });
});

describe("classifyVikeFailure", () => {
  it("403 dibaca sebagai blokir Cloudflare pada IP VPS", () => {
    expect(classifyVikeFailure(403)).toContain("Cloudflare");
  });

  it("401 dibaca sebagai key ditolak", () => {
    expect(classifyVikeFailure(401)).toContain("key ditolak");
  });

  it("429 dibaca sebagai rate limit", () => {
    expect(classifyVikeFailure(429)).toContain("rate limit");
  });

  it("503 dibaca sebagai upstream down", () => {
    expect(classifyVikeFailure(503)).toContain("down");
  });

  it("error jaringan tetap dibaca tanpa membocorkan nilai key", () => {
    const msg = classifyVikeFailure(null, "fetch failed");
    expect(msg).toContain("fetch failed");
  });
});

describe("baseCoin — normalisasi simbol API vs coin Hyperliquid", () => {
  // BUG 25 Okt 2026: markPrices / SampledPosition.coin diisi dari nama coin
  // Hyperliquid ("BTC"), sementara route API menerima "BTCUSDT".
  // Tanpa normalisasi ini markFor() selalu null dan panel LIQ MAP kosong.
  it("melepas suffix quote yang dikenal", () => {
    expect(baseCoin("BTCUSDT")).toBe("BTC");
    expect(baseCoin("btcusdt")).toBe("BTC");
    expect(baseCoin("ETHUSDC")).toBe("ETH");
    expect(baseCoin("SOLUSD")).toBe("SOL");
    expect(baseCoin("DOGEUSDT")).toBe("DOGE");
    expect(baseCoin("BNBPERP")).toBe("BNB");
  });

  it("simbol yang sudah basis tetap utuh", () => {
    expect(baseCoin("BTC")).toBe("BTC");
    expect(baseCoin("ETH")).toBe("ETH");
    expect(baseCoin("XRP")).toBe("XRP");
    expect(baseCoin("WLD")).toBe("WLD");
  });

  it("tidak mengubah simbol yang bukan pasangan quote", () => {
    expect(baseCoin("ZEC")).toBe("ZEC");
    // "USDT" itu sendiri tidak dilepas menjadi string kosong.
    expect(baseCoin("USDT")).toBe("USDT");
  });
});
