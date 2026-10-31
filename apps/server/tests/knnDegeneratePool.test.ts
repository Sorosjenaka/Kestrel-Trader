// apps/server/tests/knnDegeneratePool.test.ts
// 24 Okt 2026 (BUG FIX kolom KNN kosong di Live Market Scanner).
//
// ROOT CAUSE: library KNN produksi berisi 114 item dengan vektor fitur NETRAL
// yang identik ([50,50,50,20,1] — fallback runtime buildKnnFeatures). Semua
// item itu berjarak LORENTZIAN yang sama dari query mana pun, jadi K=5
// "tetangga terdekat" SELALU jatuh ke 5 item sentinel itu. Label win-nya
// acak -> knnProb = 0 untuk setiap kandidat: angka yang tidak didukung bukti
// apa pun, dan di UI tampil "—" (0 = falsy).
//
// FIX: item degenerat dikeluarkan dari pool QUERY (penyimpanan tetap utuh
// untuk audit). Kalau pool non-degenerate < 50, hasilnya tetap null dengan
// label INSUFFICIENT_DATA — TIDAK ada angka yang dikarang.
//
// Test ini membuktikan:
//  1) pool yang dominansi degenerat tidak lagi menghasilkan probabilitas palsu,
//  2) pool non-degenerate >= 50 menghasilkan probabilitas NYATA dari analog,
//  3) item degenerat tetap TERSIMPAN (histori tidak dihapus).
import { describe, it, expect } from "vitest";
import {
  KnnAnalogLibrary,
  KNN_NEUTRAL_FEATURES,
  buildKnnFeatures,
  isDegenerateKnnFeatures,
  queryKnnLorentzian,
  type KnnAnalogItem,
} from "../src/engines/knnAnalogEngine.js";

/** Item netral — persis fallback runtime. */
const neutralItem = (id: number, win: boolean): KnnAnalogItem => ({
  id,
  symbol: `SENT${id}USDT`,
  mode: "SCALP",
  features: [...KNN_NEUTRAL_FEATURES],
  win,
  rMultiple: win ? 1 : -1,
  timestamp: 1700000000000 + id * 1000,
});

/** Item dengan fitur diskriminatif (mirip data produksi yang sebenarnya). */
const realItem = (id: number, features: number[], win: boolean): KnnAnalogItem => ({
  id,
  symbol: `REAL${id}USDT`,
  mode: "SCALP",
  features,
  win,
  rMultiple: win ? 1.5 : -1,
  timestamp: 1700000000000 + id * 1000,
});

describe("isDegenerateKnnFeatures", () => {
  it("mengenali vektor netral runtime (fallback buildKnnFeatures)", () => {
    // buildKnnFeatures dengan data hilang persis menghasilkan vektor netral.
    const fallback = buildKnnFeatures({ zoneScore: NaN, triggerScore: NaN, trendScore: NaN, adx: null, volume24hUsd: null });
    expect(fallback).toEqual([...KNN_NEUTRAL_FEATURES]);
    expect(isDegenerateKnnFeatures(fallback)).toBe(true);
  });

  it("vektor dengan fitur nyata BUKAN degenerat", () => {
    expect(isDegenerateKnnFeatures([80, 70, 75, 30, 1.5])).toBe(false);
    expect(isDegenerateKnnFeatures([50, 50, 50, 20, 2])).toBe(false);
  });
});

describe("queryKnnLorentzian —VEKTOR NETRAL TIDAK BOLEH MENCOROTI PROBABILITAS", () => {
  it("BUG REGRESI: 114 item netral identik + 1 item nyata -> TIDAK boleh menghasilkan probabilitas", () => {
    // Susunan persis seperti library produksi: 114 sentinel, hanya 1 analog nyata.
    const history: KnnAnalogItem[] = [];
    for (let i = 0; i < 114; i++) history.push(neutralItem(i, i % 3 === 0));
    history.push(realItem(9001, [80, 70, 75, 30, 1.5], true));

    const res = queryKnnLorentzian([80, 70, 75, 30, 1.5], history, 5);

    // Pool setelah membuang degenerat = 1 < 50 -> TIDAK BOLEH ada probabilitas.
    expect(res.knnProb).toBeNull();
    expect(res.label).toBe("INSUFFICIENT_DATA");
    expect(res.knnN).toBe(1);
    expect(res.degenerateSkipped).toBe(114);
    expect(res.labelReason).toContain("KNN_POOL_1_LT_50");
    expect(res.nearestNeighbors.length).toBe(0);
  });

  it("REGRESI: tanpa fix, kueri yang sama akan mengembalikan 0 (artefak sentinel)", () => {
    // Membuktikan sifat bug: 114 sentinel identik memberi jarak seri, jadi
    // K=5 jatuh ke sentinel dan win-rate-nya 0 — angka tanpa bukti.
    const history: KnnAnalogItem[] = [];
    for (let i = 0; i < 114; i++) history.push(neutralItem(i, false));
    const query = [80, 70, 75, 30, 1.5];
    const distances = history.map((h) =>
      h.features.reduce((acc, v, idx) => acc + Math.log(1 + Math.abs(query[idx]! - v!)), 0)
    );
    // semua sentinel punya jarak identik
    expect(new Set(distances.map((d) => d.toFixed(6))).size).toBe(1);
    // dan label win semuanya false -> probabilitas lama = 0
    const top5 = [...history].sort(
      (a, b) =>
        a.features.reduce((acc, v, idx) => acc + Math.log(1 + Math.abs(query[idx]! - v!)), 0) -
        b.features.reduce((acc, v, idx) => acc + Math.log(1 + Math.abs(query[idx]! - v!)), 0)
    ).slice(0, 5);
    expect(top5.every((i) => i.win === false)).toBe(true);
  });

  it("pool >= 50 item NYATA -> probabilitas terhitung dari analog terdekat", () => {
    const history: KnnAnalogItem[] = [];
    // 60 analog nyata; 12 di antaranya win (kandidat dekat = win).
    for (let i = 0; i < 60; i++) {
      const features = [80 + (i % 6), 70 + (i % 5), 75 + (i % 4), 30 + (i % 7), 1.5];
      history.push(realItem(i, features, i < 12));
    }
    const res = queryKnnLorentzian([80, 70, 75, 30, 1.5], history, 5);
    expect(res.label).toBe("READY");
    expect(res.knnN).toBe(60);
    expect(res.degenerateSkipped).toBe(0);
    expect(res.knnProb).not.toBeNull();
    expect(res.knnProb).toBeGreaterThan(0);
    expect(res.knnProb).toBeLessThanOrEqual(1);
    expect(res.nearestNeighbors.length).toBe(5);
  });

  it("campuran: item netral dibuang, item nyata dipakai, ambang diukur pada pool yang dipakai", () => {
    const history: KnnAnalogItem[] = [];
    for (let i = 0; i < 100; i++) history.push(neutralItem(i, false));
    for (let i = 0; i < 50; i++) history.push(realItem(1000 + i, [80 + (i % 6), 70 + (i % 5), 75 + (i % 4), 30 + (i % 7), 1.5], i % 2 === 0));
    const res = queryKnnLorentzian([80, 70, 75, 30, 1.5], history, 5);
    expect(res.label).toBe("READY");
    expect(res.knnN).toBe(50);
    expect(res.degenerateSkipped).toBe(100);
    // tetangga terdekat HARUS item nyata (bukan sentinel)
    expect(res.nearestNeighbors.every((n) => n.symbol.startsWith("REAL"))).toBe(true);
  });
});

describe("KnnAnalogLibrary — histori item netral TIDAK dihapus", () => {
  it("item degenerat tetap tersimpan (audit) tapi tidak dipakai untuk query", () => {
    const lib = new KnnAnalogLibrary();
    for (let i = 0; i < 114; i++) lib.addItem(neutralItem(i, false));
    for (let i = 0; i < 60; i++) lib.addItem(realItem(2000 + i, [80 + (i % 6), 70 + (i % 5), 75 + (i % 4), 30 + (i % 7), 1.5], i % 2 === 0));

    // penyimpanan utuh
    expect(lib.count("SCALP")).toBe(174);

    // query hanya memakai pool non-degenerate
    const res = lib.query([80, 70, 75, 30, 1.5], "SCALP", 5);
    expect(res.label).toBe("READY");
    expect(res.knnN).toBe(60);
    expect(res.degenerateSkipped).toBe(114);
    expect(res.nearestNeighbors.every((n) => n.symbol.startsWith("REAL"))).toBe(true);
  });

  it("library yang HANYA berisi item netral -> INSUFFICIENT_DATA, bukan probabilitas palsu", () => {
    const lib = new KnnAnalogLibrary();
    for (let i = 0; i < 115; i++) lib.addItem(neutralItem(i, i % 2 === 0));
    const res = lib.query([80, 70, 75, 30, 1.5], "SCALP", 5);
    expect(res.label).toBe("INSUFFICIENT_DATA");
    expect(res.knnProb).toBeNull();
    expect(res.knnN).toBe(0);
    expect(res.degenerateSkipped).toBe(115);
  });
});
