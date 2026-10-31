// apps/server/tests/analysisLayer.test.ts - 23 Okt 2026 (Tahap 4).
// Fixture terisolasi: tidak ada order, tidak ada jaringan, tidak ada DB produksi.
//
// Yang diuji (semuanya hal yang SALAH kalau dibalik):
//  - maker/taker: m=true -> agresif SELL (bukan BUY)
//  - missing != 0
//  - CVD sesi dihitung dari 00:00 WIB, bukan dari boot
//  - rolling delta direbase ke nol tiap window
//  - duplikat & snapshot-ulang diabaikan
//  - warm-up ditandai
//  - status data kelas-satu
//  - coverage tidak pernah 100% tanpa denominator
import { describe, expect, it } from "vitest";
import { DeltaAccumulator, sessionStartMs, WINDOWS } from "../src/analysis/deltaEngine.js";
import { parseBinanceAggTrade } from "../src/analysis/feeds/binanceAggTrade.js";
import { computeStatus, emptyHealth, computeCoverage } from "../src/analysis/dataStatus.js";
import { featureSnapshotSchema, strategyAnalysisSchema, DATA_STATUS } from "../src/analysis/contracts.js";

const NOW = Date.parse("2026-10-23T12:00:00Z");

describe("maker/taker Binance aggTrade", () => {
  it("m=true (buyer maker) -> agresif SELL", () => {
    const raw = JSON.stringify({ e: "aggTrade", E: NOW, s: "BTCUSDT", a: 1, p: "100", q: "2", m: true, T: NOW });
    const r = parseBinanceAggTrade(raw, "BTCUSDT");
    expect(r?.tick.aggressor).toBe("SELL");
    expect(r?.tick.price).toBe(100);
    expect(r?.tick.qty).toBe(2);
  });

  it("m=false (seller maker) -> agresif BUY", () => {
    const raw = JSON.stringify({ e: "aggTrade", E: NOW, s: "BTCUSDT", a: 2, p: "100", q: "2", m: false, T: NOW });
    expect(parseBinanceAggTrade(raw, "BTCUSDT")?.tick.aggressor).toBe("BUY");
  });

  it("payload combined stream ({stream,data}) diterima", () => {
    const raw = JSON.stringify({ stream: "btcusdt@aggTrade", data: { e: "aggTrade", E: NOW, s: "BTCUSDT", a: 3, p: "1", q: "1", m: false, T: NOW } });
    expect(parseBinanceAggTrade(raw, "BTCUSDT")?.tick.id).toBe("a3");
  });

  it("simbol lain / payload rusak -> null (bukan crash, bukan tick palsu)", () => {
    expect(parseBinanceAggTrade("bukan json")).toBeNull();
    expect(parseBinanceAggTrade(JSON.stringify({ e: "kline", s: "BTCUSDT" }))).toBeNull();
    expect(parseBinanceAggTrade(JSON.stringify({ e: "aggTrade", s: "ETHUSDT", a: 1, p: "1", q: "1", m: false, T: NOW }), "BTCUSDT")).toBeNull();
    // harga/qty tidak valid -> null
    expect(parseBinanceAggTrade(JSON.stringify({ e: "aggTrade", s: "BTCUSDT", a: 1, p: "0", q: "1", m: false, T: NOW }), "BTCUSDT")).toBeNull();
  });
});

describe("akumulator delta", () => {
  it("delta = beli agresif - jual agresif (bukan arus kas)", () => {
    const acc = new DeltaAccumulator();
    acc.ingest({ id: "1", eventTime: NOW - 1000, price: 100, qty: 1, aggressor: "BUY" });
    acc.ingest({ id: "2", eventTime: NOW - 900, price: 100, qty: 2, aggressor: "SELL" });
    const out = acc.compute(NOW);
    const w = out.byWindow["5m"]!;
    expect(w.buyNotional).toBe(100);
    expect(w.sellNotional).toBe(200);
    expect(w.deltaNotional).toBe(-100);
    expect(w.totalNotional).toBe(300);
    expect(w.buyRatio).toBeCloseTo(1 / 3, 6);
    expect(w.tradeCount).toBe(2);
  });

  it("duplikat & snapshot-ulang diabaikan (tidak dihitung dua kali)", () => {
    const acc = new DeltaAccumulator();
    const tick = { id: "x1", eventTime: NOW - 1000, price: 100, qty: 1, aggressor: "BUY" as const };
    expect(acc.ingest(tick)).toBe(true);
    expect(acc.ingest(tick)).toBe(false); // duplikat
    expect(acc.ingest({ ...tick, eventTime: NOW - 500 })).toBe(false); // snapshot ulang id sama
    expect(acc.compute(NOW).byWindow["5m"]!.tradeCount).toBe(1);
    expect(acc.stats().duplicates).toBe(2);
  });

  it("tidak ada data -> buyRatio null dan cvdSession null (BUKAN 0)", () => {
    const acc = new DeltaAccumulator();
    const w = acc.compute(NOW).byWindow["5m"]!;
    expect(w.buyRatio).toBeNull();
    expect(w.cvdSession).toBeNull();
    expect(w.totalNotional).toBe(0);
  });

  it("CVD sesi dihitung dari 00:00 WIB (07:00 UTC), bukan dari boot", () => {
    // 23 Okt 12:00 UTC = 19:00 WIB -> sesi 23 Okt dimulai 22 Okt 17:00 UTC.
    expect(sessionStartMs(NOW)).toBe(Date.parse("2026-10-22T17:00:00Z"));
    // Akumulator yang mulai SEBELUM awal sesi -> CVD sesi valid.
    const acc = new DeltaAccumulator({ now: Date.parse("2026-10-22T16:00:00Z") });
    // Trade sebelum awal sesi (16:00 UTC) tidak masuk CVD sesi; 18:00 UTC masuk.
    acc.ingest({ id: "pre", eventTime: Date.parse("2026-10-22T16:00:00Z"), price: 100, qty: 1, aggressor: "BUY" });
    acc.ingest({ id: "post", eventTime: Date.parse("2026-10-22T18:00:00Z"), price: 100, qty: 1, aggressor: "BUY" });
    const out = acc.compute(NOW);
    expect(out.sessionObserved).toBe(true);
    // Hanya trade sesi (1 x 100), bukan 2 x 100.
    expect(out.byWindow["4h"]!.cvdSession).toBe(100);
  });

  it("bucket yang memotong batas sesi tidak membawa trade sebelum sesi", () => {
    // Regresi: bucket per menit dihitung utuh, sehingga trade 1 menit
    // SEBELUM awal sesi ikut terhitung ke CVD sesi.
    const acc = new DeltaAccumulator({ now: Date.parse("2026-10-22T16:59:30Z") });
    // Trade di menit 16:59 (sebelum sesi 17:00) -> tidak boleh masuk CVD sesi.
    acc.ingest({ id: "edge", eventTime: Date.parse("2026-10-22T16:59:30Z"), price: 100, qty: 1, aggressor: "BUY" });
    acc.ingest({ id: "in", eventTime: Date.parse("2026-10-22T17:00:30Z"), price: 100, qty: 1, aggressor: "BUY" });
    const out = acc.compute(NOW);
    // Maksimal ~100 (hanya trade sesi) — BUKAN 200.
    expect(out.byWindow["4h"]!.cvdSession).toBeLessThanOrEqual(150);
    expect(out.byWindow["4h"]!.cvdSession).toBeGreaterThan(50);
  });

  it("akumulator yang baru mulai DI TENGAH sesi -> CVD sesi null (bukan angka parsial)", () => {
    const acc = new DeltaAccumulator({ now: Date.parse("2026-10-23T10:00:00Z") });
    acc.ingest({ id: "late", eventTime: Date.parse("2026-10-23T11:00:00Z"), price: 100, qty: 1, aggressor: "BUY" });
    const out = acc.compute(NOW);
    expect(out.sessionObserved).toBe(false);
    expect(out.byWindow["1h"]!.cvdSession).toBeNull();
    // Tapi delta jendela tetap ada (terukur utuh dalam jendela).
    expect(out.byWindow["1h"]!.rollingDelta).toBe(100);
  });

  it("rolling delta direbase ke nol per window; CVD sesi tidak", () => {
    // Akumulator mulai SEBELUM awal sesi -> CVD sesi valid.
    const acc = new DeltaAccumulator({ now: Date.parse("2026-10-22T16:00:00Z") });
    acc.ingest({ id: "a", eventTime: NOW - 2 * 60_000, price: 100, qty: 1, aggressor: "BUY" });
    acc.ingest({ id: "b", eventTime: NOW - 2 * 60_000, price: 100, qty: 1, aggressor: "SELL" });
    const out = acc.compute(NOW);
    // Window 5m memuat keduanya -> delta 0; window 1h juga.
    expect(out.byWindow["5m"]!.rollingDelta).toBe(0);
    expect(out.byWindow["1h"]!.rollingDelta).toBe(0);
    // CVD sesi tetap terakumulasi penuh (tidak direbase ke nol per window).
    expect(out.byWindow["1h"]!.cvdSession).toBe(0);
  });

  it("warm-up: jendela yang sudah tercakup penuh TIDAK warm-up, jendela yang belum diamati warm-up", () => {
    const acc = new DeltaAccumulator({ now: NOW - 30 * 60_000 });
    // Feed aktif sejak 30 menit lalu -> jendela 5m & 15m sudah tercakup penuh
    // (meski kosong, itu hasil pengamatan nyata, bukan data hilang).
    acc.ingest({ id: "old", eventTime: NOW - 30 * 60_000, price: 100, qty: 1, aggressor: "BUY" });
    const out = acc.compute(NOW);
    expect(out.byWindow["5m"]!.warmup).toBe(false);
    expect(out.byWindow["15m"]!.warmup).toBe(false);
    // Jendela 1h & 4h belum tercakup (feed baru hidup 30 menit lalu).
    expect(out.byWindow["1h"]!.warmup).toBe(true);
    expect(out.byWindow["4h"]!.warmup).toBe(true);
  });

  it("warm-up hilang setelah trade tertua melewati batas awal jendela", () => {
    const acc = new DeltaAccumulator();
    // Trade 2 jam lalu -> jendela 1h sudah tercakup penuh.
    acc.ingest({ id: "old", eventTime: NOW - 2 * 60 * 60_000, price: 100, qty: 1, aggressor: "BUY" });
    acc.ingest({ id: "new", eventTime: NOW - 60_000, price: 100, qty: 1, aggressor: "BUY" });
    const out = acc.compute(NOW);
    expect(out.byWindow["1h"]!.warmup).toBe(false);
    expect(out.byWindow["4h"]!.warmup).toBe(true); // 4h masih belum tercakup
  });

  it("window di luar daftar diabaikan", () => {
    expect(WINDOWS.map((w) => w.key)).toEqual(["5m", "15m", "1h", "4h"]);
  });

  it("jumlah transaksi TIDAK boleh terpotong batas buffer (regresi 23 Okt 2026)", () => {
    // Bug nyata di produksi: queue per-tick dipotong di 4.000, jadi kolom
    // "TRANSAKSI" di UI menampilkan 4.000 padahal aslinya lebih banyak.
    // Bucket per menit harus menjumlahkan SEMUA trade dengan benar.
    const acc = new DeltaAccumulator({ now: NOW });
    const N = 9_000;
    for (let i = 0; i < N; i++) {
      // Semua trade dalam 1 menit yang sama -> 1 bucket.
      acc.ingest({ id: `t${i}`, eventTime: NOW - 30_000, price: 100, qty: 1, aggressor: "BUY" });
    }
    const out = acc.compute(NOW);
    expect(out.byWindow["5m"]!.tradeCount).toBe(N);
    expect(out.byWindow["5m"]!.buyNotional).toBe(N * 100);
    expect(out.ingested).toBe(N);
    // Memori tetap kecil: 1 bucket untuk 9.000 trade.
    expect(acc.stats().buckets).toBe(1);
  });

  it("bucket per menit menjumlahkan multi-menit dengan benar", () => {
    const acc = new DeltaAccumulator({ now: NOW });
    // 3 menit terakhir, masing-masing 2 trade: 1 BUY + 1 SELL
    for (let m = 0; m < 3; m++) {
      const t = NOW - m * 60_000 - 5_000;
      acc.ingest({ id: `b${m}`, eventTime: t, price: 100, qty: 1, aggressor: "BUY" });
      acc.ingest({ id: `s${m}`, eventTime: t, price: 100, qty: 2, aggressor: "SELL" });
    }
    const out = acc.compute(NOW);
    const w = out.byWindow["5m"]!;
    expect(w.tradeCount).toBe(6);
    expect(w.buyNotional).toBe(300);
    expect(w.sellNotional).toBe(600);
    expect(w.deltaNotional).toBe(-300);
    expect(acc.stats().buckets).toBe(3);
  });

  it("bucket dari sesi sebelumnya dibuang (memori terkendali)", () => {
    const acc = new DeltaAccumulator({ now: NOW });
    // Trade dari SESI SEBELUMNYA (20 jam lalu, sesi lalu) -> dibuang.
    acc.ingest({ id: "old", eventTime: NOW - 20 * 60 * 60_000, price: 100, qty: 1, aggressor: "BUY" });
    acc.ingest({ id: "new", eventTime: NOW - 10_000, price: 100, qty: 1, aggressor: "BUY" });
    const out = acc.compute(NOW);
    // Trade lama tidak masuk jendela 1h.
    expect(out.byWindow["1h"]!.tradeCount).toBe(1);
    expect(acc.stats().buckets).toBe(1);
  });

  it("bucket dari sesi berjalan TIDAK dibuang walau jendela 4 jam sudah lewat", () => {
    // Sesi bisa >4 jam. Kalau bucket awal sesi dibuang, CVD sesi undercount.
    const acc = new DeltaAccumulator({ now: NOW - 19 * 60 * 60_000 });
    acc.ingest({ id: "sessionStart", eventTime: Date.parse("2026-10-22T17:00:30Z"), price: 100, qty: 1, aggressor: "BUY" });
    const out = acc.compute(NOW);
    expect(out.sessionObserved).toBe(true);
    expect(out.byWindow["4h"]!.cvdSession).toBe(100);
  });
});

describe("status data kelas-satu", () => {
  it("tidak didukung -> UNSUPPORTED", () => {
    const h = emptyHealth(false);
    expect(computeStatus(h, "trades", NOW).status).toBe("UNSUPPORTED");
  });

  it("belum ada event -> LOADING", () => {
    expect(computeStatus(emptyHealth(true), "trades", NOW).status).toBe("LOADING");
  });

  it("umur data > TTL -> STALE", () => {
    const h = { ...emptyHealth(true), lastEventAt: NOW - 60_000 };
    expect(computeStatus(h, "trades", NOW).status).toBe("STALE");
  });

  it("koneksi putus tanpa fallback -> DISCONNECTED", () => {
    const h = { ...emptyHealth(true), lastDisconnectAt: NOW - 5_000, lastEventAt: NOW - 60_000 };
    expect(computeStatus(h, "trades", NOW).status).toBe("DISCONNECTED");
  });

  it("error sementara tapi data segar -> PARTIAL", () => {
    const h = { ...emptyHealth(true), lastEventAt: NOW - 1_000, errors: ["reset socket"] };
    expect(computeStatus(h, "trades", NOW).status).toBe("PARTIAL");
  });

  it("sehat -> COMPLETE", () => {
    const h = { ...emptyHealth(true), lastEventAt: NOW - 1_000, lastConnectAt: NOW - 5_000 };
    expect(computeStatus(h, "trades", NOW).status).toBe("COMPLETE");
  });

  it("TTL per jenis data berbeda (trades != oi)", () => {
    const h = { ...emptyHealth(true), lastEventAt: NOW - 60_000 };
    expect(computeStatus(h, "trades", NOW).status).toBe("STALE");
    expect(computeStatus(h, "oi", NOW).status).toBe("COMPLETE");
  });

  it("coverage tidak boleh 100% tanpa denominator", () => {
    expect(computeCoverage(10, null)).toEqual({ present: 0, total: 0 });
    expect(computeCoverage(10, 20)).toEqual({ present: 10, total: 20 });
    expect(computeCoverage(30, 20)).toEqual({ present: 20, total: 20 });
  });
});

describe("kontrak zod", () => {
  it("status data yang tidak dikenal ditolak", () => {
    expect(DATA_STATUS).toContain("STALE");
    const bad = featureSnapshotSchema.safeParse({
      snapshotId: "s", featureVersion: "v", builtAt: NOW, eventTimeMax: NOW,
      instrument: { venue: "BINANCE", marketType: "PERP", instrumentId: "BTCUSDT PERPETUAL", base: "BTC", quote: "USDT", settlementAsset: "USDT", marginAsset: "USDT", contractType: "LINEAR" },
      dataStatus: { "PERP:BTCUSDT": { status: "BAGUS", ageMs: 1, ttlMs: 1000 } },
      coverage: {}, features: { deltaByWindow: {}, bookBand: null, liquidationEvent: null, positionLevelMap: null, oiFunding: null },
    });
    expect(bad.success).toBe(false);
  });

  it("output analis wajib punya alasan stance + ringkasan UI lengkap", () => {
    const r = strategyAnalysisSchema.safeParse({
      analysisId: "a", strategyId: "RSW-01", agentId: "analis-arus", snapshotId: "s",
      evaluatedAt: NOW, expiresAt: NOW + 3600_000,
      marketHypothesis: "h", horizon: "4h",
      stance: "SUPPORTED", stanceReason: "karena", role: "CONTEXT",
      uiSummary: { status: "TUNGGU", alasan: "a", pemicu: "p", batal: "b" },
    });
    expect(r.success).toBe(true);
  });

  it("stance tanpa alasan ditolak (LLM tidak boleh mengarang)', ", () => {
    const r = strategyAnalysisSchema.safeParse({
      analysisId: "a", strategyId: "RSW-01", agentId: "x", snapshotId: "s",
      evaluatedAt: NOW, expiresAt: NOW + 1000, marketHypothesis: "h", horizon: "4h",
      stance: "SUPPORTED", role: "CONTEXT",
      uiSummary: { status: "TUNGGU", alasan: "a", pemicu: "p", batal: "b" },
    });
    expect(r.success).toBe(false);
  });

  it("ringkasan UI tanpa BATAL ditolak (batal wajib ada)", () => {
    const r = strategyAnalysisSchema.safeParse({
      analysisId: "a", strategyId: "RSW-01", agentId: "x", snapshotId: "s",
      evaluatedAt: NOW, expiresAt: NOW + 1000, marketHypothesis: "h", horizon: "4h",
      stance: "NEUTRAL", stanceReason: "x", role: "CONTEXT",
      uiSummary: { status: "TUNGGU", alasan: "a", pemicu: "p" },
    });
    expect(r.success).toBe(false);
  });
});
