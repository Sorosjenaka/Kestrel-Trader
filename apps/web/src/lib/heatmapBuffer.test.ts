// apps/web/src/lib/heatmapBuffer.test.ts
// Unit test buffer heatmap (audit 14 Okt 2026). Jalankan: npx vitest run.
import { describe, it, expect } from "vitest";
import {
  HeatmapBuffer, SNAPSHOT_MS, WINDOW_MS, ROWS, RANGE_PCT, binRowFromMid, decayFactor,
  binPriceBounds, priceY, type DepthSide,
} from "./heatmapBuffer.js";

const depth = (bidP: number, bidQ: number, askP: number, askQ: number): DepthSide => ({
  bids: [[String(bidP), String(bidQ)]],
  asks: [[String(askP), String(askQ)]],
});

describe("HeatmapBuffer", () => {
  it("mengakumulasi kolom historis dan memetakan waktu ke bucket tetap", () => {
    const buf = new HeatmapBuffer();
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 5; i++) {
      buf.pushSnapshot(t0 + i * SNAPSHOT_MS, 100, depth(99.9, 1, 100.1, 2));
    }
    expect(buf.length).toBe(5);
    const cols = buf.columns();
    expect(cols[0]!.t).toBe(t0); // bucket = floor ke kelipatan SNAPSHOT_MS
    expect(cols[4]!.t).toBe(t0 + 4 * SNAPSHOT_MS);
    expect(cols.every((c) => c.mid === 100)).toBe(true);
  });

  it("kolom yang sama dalam bucket yang sama menimpa, bukan dobel", () => {
    const buf = new HeatmapBuffer();
    const t = 1_700_000_000_000;
    buf.pushSnapshot(t, 100, depth(99.9, 1, 100.1, 2));
    buf.pushSnapshot(t + 100, 100, depth(99.9, 4, 100.1, 4)); // bucket sama
    expect(buf.length).toBe(1);
    const col = buf.columns()[0]!;
    // Nilai = snapshot TERBARU (4×harga), bukan akumulasi (1+4)×harga.
    expect(col.values.every((v) => v <= 4 * 101)).toBe(true);
    expect(col.values.some((v) => v >= 4 * 99)).toBe(true);
  });

  it("gap waktu (fetch gagal) menjadi kolom kosong — TIDAK diinterpolasi", () => {
    const buf = new HeatmapBuffer();
    const t0 = 1_700_000_000_000;
    buf.pushSnapshot(t0, 100, depth(99.9, 1, 100.1, 1));
    buf.pushSnapshot(t0 + SNAPSHOT_MS * 4, 100, depth(99.9, 1, 100.1, 1)); // skip 3 bucket
    expect(buf.length).toBe(2); // hanya 2 kolom observasi; celah tetap celah
  });

  it("pemetaan bin: bid dekat mid = row 0 di bawah, ask dekat mid = row 0 di atas", () => {
    const buf = new HeatmapBuffer();
    const mid = 100;
    // bid -0.05% (dekat) dan -0.4% (jauh); ask +0.05% dan +0.4%
    buf.pushSnapshot(1_700_000_000_000, mid, {
      bids: [[String(mid * 0.9995), "1"], [String(mid * 0.996), "2"]],
      asks: [[String(mid * 1.0005), "3"], [String(mid * 1.004), "4"]],
    });
    const col = buf.columns()[0]!;
    const nearBid = HALF_OFFSET(); // helper di bawah
    expect(nearBid.bidNear0).toBe(true);
    expect(col.values).toContain((1 * mid * 0.9995)); // notional bid dekat
    expect(nearBid.askNear).toBe(true);
  });

  it("removed walls remain historical and do not become fresh liquidity", () => {
    const buf = new HeatmapBuffer();
    const t0 = 1_700_000_000_000;
    buf.pushSnapshot(t0, 100, depth(99.9, 10, 100.1, 0));
    buf.pushSnapshot(t0 + SNAPSHOT_MS, 101, { bids: [], asks: [] });
    expect(buf.columns()[0]!.values.some(v => v > 0)).toBe(true);
    expect(buf.columns()[1]!.values.every(v => v === 0)).toBe(true);
  });

  it("draws historical prices on the current absolute axis, with a 0.04% bin", () => {
    const [lo, hi] = binPriceBounds(100, 20);
    expect(lo).toBe(100);
    expect(hi).toBeCloseTo(100.04);
    expect(priceY(100, 100, 400)).toBe(200);
    expect(priceY(100.8, 100, 400)).toBeCloseTo(0);
    expect(priceY(99.2, 100, 400)).toBeCloseTo(400);
    expect(priceY(100, 100.4, 400)).toBeGreaterThan(200);
  });

  it("restores versioned history but rejects legacy ghost-liquidity data", () => {
    const buf = new HeatmapBuffer(), restored = new HeatmapBuffer();
    const t = Date.now() - 1000;
    buf.pushSnapshot(t, 100, depth(99.9, 1, 100.1, 1));
    restored.restore(buf.serialize());
    expect(restored.length).toBe(1);
    expect(restored.mid).toBe(100);
    const legacy = new HeatmapBuffer();
    legacy.restore(JSON.stringify([{ t, mid: 100, v: [100], b: [1], l: [t] }]));
    expect(legacy.length).toBe(0);
  });

  it("prune membuang kolom lebih tua dari WINDOW_MS (retensi 15 menit)", () => {
    const buf = new HeatmapBuffer();
    const now = Date.now();
    buf.pushSnapshot(now - WINDOW_MS - 10_000, 100, depth(99.9, 1, 100.1, 1));
    buf.pushSnapshot(now, 100, depth(99.9, 1, 100.1, 1));
    buf.prune(now);
    expect(buf.length).toBe(1);
  });

  it("normalisasi P95: satu dinding raksasa tidak mempipihkan skala", () => {
    const buf = new HeatmapBuffer();
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 20; i++) {
      buf.pushSnapshot(t0 + i * SNAPSHOT_MS, 100, depth(99.9, 1, 100.1, i === 19 ? 100 : 1));
    }
    const { p95 } = buf.intensityGrid();
    // P95 jauh di bawah max (dinding 100x) — skala tetap terbaca
    expect(p95).toBeGreaterThan(0);
    expect(p95).toBeLessThan(100 * 100); // < dinding notional
  });

  it("order book kosong / sparse tidak menghasilkan nilai palsu", () => {
    const buf = new HeatmapBuffer();
    buf.pushSnapshot(1_700_000_000_000, 100, { bids: [], asks: [] });
    const col = buf.columns()[0]!;
    expect(Array.from(col.values).every((v) => v === 0)).toBe(true);
    expect(buf.p95()).toBe(0);
    const { p95 } = buf.intensityGrid();
    expect(p95).toBe(0);
  });

  it("binRowFromMid & decayFactor konsisten dengan kebijakan", () => {
    expect(binRowFromMid(19)).toEqual({ side: "bid", row: 0 }); // bid tepat di bawah mid
    expect(binRowFromMid(20)).toEqual({ side: "ask", row: 0 }); // ask tepat di atas mid
    expect(binRowFromMid(0)).toEqual({ side: "bid", row: 19 }); // bid terjauh
    expect(binRowFromMid(39)).toEqual({ side: "ask", row: 19 }); // ask terjauh
    expect(decayFactor(0)).toBe(1);
    expect(decayFactor(30)).toBeCloseTo(0.25, 5); // 2 half-life
  });
});

function HALF_OFFSET() {
  // Asersi gabungan untuk test pemetaan bin (menjaga test tetap ringkas).
  return {
    bidNear0: binRowFromMid(19).side === "bid" && binRowFromMid(19).row === 0,
    askNear: binRowFromMid(20).side === "ask" && binRowFromMid(20).row === 0,
  };
}
