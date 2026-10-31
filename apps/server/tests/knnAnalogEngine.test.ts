import { describe, it, expect } from "vitest";
import {
  lorentzianDistance,
  queryKnnLorentzian,
  KnnAnalogLibrary,
  KnnAnalogItem,
  calculateCompositeScore,
  rankCandidates,
  ScoredCandidateInput,
} from "../src/engines/knnAnalogEngine.js";

describe("FR-12: Library Analog KNN Lorentzian & FR-13: Skor Gabungan + Ranking", () => {
  describe("Jarak Lorentzian", () => {
    it("menghasilkan 0 untuk dua vektor identik", () => {
      const v = [80, 75, 70, 25, 1.2];
      expect(lorentzianDistance(v, v)).toBe(0);
    });

    it("menghasilkan jarak positif dan simetris", () => {
      const u = [80, 70, 60];
      const v = [85, 72, 58];
      const d1 = lorentzianDistance(u, v);
      const d2 = lorentzianDistance(v, u);
      expect(d1).toBeGreaterThan(0);
      expect(d1).toBe(d2);
    });
  });

  describe("FR-12: Query KNN Lorentzian", () => {
    it("mengembalikan probabilitas null dan label INSUFFICIENT_DATA bila n < 50", () => {
      const history: KnnAnalogItem[] = [];
      for (let i = 0; i < 49; i++) {
        history.push({
          id: i + 1,
          symbol: "BTCUSDT",
          mode: "SCALP",
          features: [70 + (i % 10), 65, 60, 25, 1.1],
          win: i % 2 === 0,
          rMultiple: i % 2 === 0 ? 1.5 : -1.0,
          timestamp: 1700000000000 + i * 1000,
        });
      }

      const query = [75, 65, 60, 25, 1.1];
      const res = queryKnnLorentzian(query, history, 5);

      expect(res.knnN).toBe(49);
      expect(res.knnProb).toBeNull();
      expect(res.label).toBe("INSUFFICIENT_DATA");
      expect(res.nearestNeighbors.length).toBe(0);
    });

    it("menghitung K=5 tetangga terdekat dan probabilitas kemenangan saat n >= 50", () => {
      const history: KnnAnalogItem[] = [];
      for (let i = 0; i < 60; i++) {
        history.push({
          id: i + 1,
          symbol: "NEARUSDT",
          mode: "SCALP",
          // 24 Okt 2026: fixture diubah dari [i,i,i,...] menjadi [i+1,i+2,i+3,...].
          // Alasannya: bentuk lama MEMBUAT item i=50 bernilai [50,50,50,20,1.0]
          // yang PERSIS sama dengan vektor netral runtime, sehingga item itu
          // kini dianggap degenerat dan dikeluarkan dari pool query. Offset
          // 1/2/3 membuat TIDAK ADA item yang bisa menabrakkan vektor netral
          // (butuh i+1=50 DAN i+2=50 bersamaan -> mustahil).
          features: [i + 1, i + 2, i + 3, 20, 1.0],
          win: i >= 28 && i <= 31 ? true : false,
          rMultiple: 1.2,
          timestamp: 1700000000000 + i * 1000,
        });
      }

      // Query persis cocok dengan item i=29 (jarak 0).
      const query = [30, 31, 32, 20, 1.0];
      const res = queryKnnLorentzian(query, history, 5);

      expect(res.knnN).toBe(60);
      expect(res.degenerateSkipped).toBe(0);
      expect(res.label).toBe("READY");
      expect(res.nearestNeighbors.length).toBe(5);
      // 4 dari 5 tetangga terdekat menang (i=28,29,30,31) -> 0.8
      expect(res.knnProb).toBe(0.8);
      expect(res.nearestNeighbors[0]!.distance).toBe(0);
    });
  });

  describe("KnnAnalogLibrary Store", () => {
    it("menyimpan item SCALP dan tidak lagi memecah pool per mode", () => {
      const lib = new KnnAnalogLibrary();
      const mockItems: KnnAnalogItem[] = [];

      for (let i = 0; i < 30; i++) {
        mockItems.push({
          id: `scalp_${i}`,
          symbol: "SOLUSDT",
          mode: "SCALP",
          features: [80, 70, 75, 30, 1.5],
          win: true,
          rMultiple: 1.0,
          timestamp: 1700000000000 + i,
        });
      }
      for (let i = 0; i < 25; i++) {
        mockItems.push({
          id: `scalp_b_${i}`,
          symbol: "ETHUSDT",
          mode: "SCALP",
          features: [85, 80, 80, 35, 1.8],
          win: true,
          rMultiple: 2.0,
          timestamp: 1700000000000 + i,
        });
      }

      lib.seedItems(mockItems);
      expect(lib.count()).toBe(55);
      expect(lib.count("SCALP")).toBe(55);

      const resMode = lib.query([80, 70, 75, 30, 1.5], "SCALP", 5);
      const resTotal = lib.query([80, 70, 75, 30, 1.5], undefined, 5);
      // SCALP-only: filter mode tidak lagi memecah pool — hasilnya identik.
      expect(resMode).toEqual(resTotal);
      expect(resTotal.label).toBe("READY");
      expect(resTotal.knnProb).toBe(1.0);
    });
  });

  describe("FR-13: Skor Gabungan Deterministik (0-100)", () => {
    it("menghitung skor gabungan berbobot saat knnProb tersedia", () => {
      const score = calculateCompositeScore({
        zoneScore: 82,
        triggerScore: 74,
        trendScore: 77,
        knnProb: 0.71,
      });

      expect(score).toBeGreaterThanOrEqual(75);
      expect(score).toBeLessThanOrEqual(80);
    });

    it("redistribusi proporsional saat knnProb null", () => {
      const score = calculateCompositeScore({
        zoneScore: 80,
        triggerScore: 80,
        trendScore: 80,
        knnProb: null,
      });

      expect(score).toBe(80);
    });
  });

  describe("FR-13: Ranking Kandidat", () => {
    it("mengurutkan kandidat menurun berdasarkan skor gabungan dan menetapkan rank", () => {
      const candidates: ScoredCandidateInput[] = [
        {
          symbol: "LOW_SCORE",
          mode: "SCALP",
          regime: "RANGING",
          zoneScore: 40,
          triggerScore: 30,
          trendScore: 35,
          gatesPass: { volume: true },
        },
        {
          symbol: "TOP_SCORE",
          mode: "SCALP",
          regime: "TRENDING",
          zoneScore: 90,
          triggerScore: 85,
          trendScore: 85,
          knnProb: 0.8,
          gatesPass: { volume: true },
        },
        {
          symbol: "MID_SCORE",
          mode: "SCALP",
          regime: "TRENDING",
          zoneScore: 70,
          triggerScore: 65,
          trendScore: 65,
          gatesPass: { volume: true },
        },
      ];

      const res = rankCandidates(candidates);
      expect(res.total).toBe(3);
      expect(res.ranked[0]!.symbol).toBe("TOP_SCORE");
      expect(res.ranked[0]!.rank).toBe(1);
      expect(res.ranked[1]!.symbol).toBe("MID_SCORE");
      expect(res.ranked[1]!.rank).toBe(2);
      expect(res.ranked[2]!.symbol).toBe("LOW_SCORE");
      expect(res.ranked[2]!.rank).toBe(3);
    });

    it("memproses ranking untuk universe 526 pair jauh di bawah batas NFR-01 (<= 90 detik)", () => {
      const universe526: ScoredCandidateInput[] = [];
      for (let i = 0; i < 526; i++) {
        universe526.push({
          symbol: `PAIR_${i}USDT`,
          mode: "SCALP",
          regime: "TRENDING",
          zoneScore: 50 + (i % 50),
          triggerScore: 40 + (i % 60),
          trendScore: 45 + (i % 55),
          knnProb: i % 2 === 0 ? 0.6 : null,
          gatesPass: { volume: true },
        });
      }

      const res = rankCandidates(universe526);
      expect(res.total).toBe(526);
      expect(res.ranked.length).toBe(526);
      expect(res.ranked[0]!.rank).toBe(1);
      expect(res.ranked[525]!.rank).toBe(526);
      expect(res.durationMs).toBeLessThan(1000);
    });
  });

});
