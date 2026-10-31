// apps/server/src/marketdata/priceHistory.test.ts
// 24 Okt 2026 — regression test untuk perbaikan performa mikrostruktur.
//
// Konteks: /api/orderflow/BTC butuh 51 detik (timeout di 25 detik) karena
// priceHistory menyimpan SATU objek {t,v} PER TRANSAKSI. Dengan ~280 transaksi/
// detik dari 10 venue, sesi 2 jam = ~2 juta objek hidup per simbol -> heap
// ~1 GB di box 1.9 GB -> 653 MB ter-swap -> major GC page-fault ke disk.
// Test ini mengunci INVARIAN yang diperbaiki:
//
//   1) Memori TERBATAS: 1 jam trading (~3600 transaksi) harus menghasilkan
//      paling banyak ~3600 sampel, BUKAN 3600 entri terpisah per transaksi.
//      Contoh nyata: 60.000 transaksi dalam 60 detik = 60 sampel.
//   2) Serialisasi: 1 sampel per detik, harga "close" detik itu.
//   3) Out-of-order (transaksi terlambat) tidak merusak urutan waktu.
//   4) Eviction jendela: sampel di luar retensi dibuang.
//   5) Seri yang dikirim ke browser tidak punya duplikat timestamp.
//   6) firstSince() mengembalikan harga window-start yang benar.

import { describe, expect, it } from "vitest";
import { PriceHistory } from "./priceHistory.js";

const HOUR = 3600_000;

describe("PriceHistory — 1 sampel per detik (bukan per transaksi)", () => {
  it("10.000 transaksi dalam 1 detik menghasilkan 1 sampel, bukan 10.000", () => {
    const ph = new PriceHistory(3 * HOUR);
    const t0 = Date.UTC(2026, 0, 2, 3, 0, 0);
    // Semua transaksi di dalam detik yang sama (offset < 1000 ms).
    for (let i = 0; i < 10_000; i++) ph.push(t0 + (i % 1000), 100 + i);

    expect(ph.size).toBe(1);
    // Harga yang bertahan = "close" detik itu (transaksi terakhir).
    expect(ph.toArray()[0]!.v).toBe(100 + 9_999);
  });

  it("10.000 transaksi yang membentang 10 detik menghasilkan 10 sampel", () => {
    const ph = new PriceHistory(3 * HOUR);
    const t0 = Date.UTC(2026, 0, 2, 3, 0, 0);
    for (let i = 0; i < 10_000; i++) ph.push(t0 + i, 100 + i);
    expect(ph.size).toBe(10);
  });

  it("60.000 transaksi di 60 detik = 60 sampel (bukan 60.000)", () => {
    const ph = new PriceHistory(3 * HOUR);
    const t0 = Date.UTC(2026, 0, 2, 3, 0, 0);
    for (let s = 0; s < 60; s++) {
      for (let i = 0; i < 1000; i++) ph.push(t0 + s * 1000 + i, 100 + s);
    }
    expect(ph.size).toBe(60);
  });

  it("transaksi pada detik BERBEDA membuat sampel baru", () => {
    const ph = new PriceHistory(3 * HOUR);
    const t0 = Date.UTC(2026, 0, 2, 3, 0, 0);
    ph.push(t0, 100);
    ph.push(t0 + 1000, 101);
    ph.push(t0 + 2000, 102);
    expect(ph.size).toBe(3);
    expect(ph.toArray().map((s) => s.v)).toEqual([100, 101, 102]);
  });

  it("sampel terakhir diperbarui saat transaksi masih di detik yang sama", () => {
    const ph = new PriceHistory(3 * HOUR);
    const t0 = Date.UTC(2026, 0, 2, 3, 0, 0);
    ph.push(t0, 100);
    ph.push(t0 + 500, 105);
    expect(ph.size).toBe(1);
    expect(ph.toArray()[0]!.v).toBe(105);
  });
});

describe("PriceHistory — transaksi terlambat (out-of-order)", () => {
  it("transaksi lama diabaikan, tidak merusak urutan waktu", () => {
    const ph = new PriceHistory(3 * HOUR);
    const t0 = Date.UTC(2026, 0, 2, 3, 0, 0);
    ph.push(t0, 100);
    ph.push(t0 + 2000, 102);
    // Transaksi terlambat (venue reconnect) — timestamp LAWAT.
    ph.push(t0 + 1000, 999);

    expect(ph.size).toBe(2);
    const arr = ph.toArray();
    expect(arr[0]!.v).toBe(100);
    expect(arr[1]!.v).toBe(102);
    // Urutan waktu tetap menaik.
    expect(arr[0]!.t).toBeLessThan(arr[1]!.t);
  });

  it("harga terakhir (lastPrice) tidak dipengaruhi sampler", () => {
    // Catatan: lastPrice di hub di-set tiap trade (bukan lewat PriceHistory),
    // jadi sampler yang menunda transaksi lama TIDAK boleh menimpa harga
    // terakhir yang sudah diketahui.
    const ph = new PriceHistory(3 * HOUR);
    const t0 = Date.UTC(2026, 0, 2, 3, 0, 0);
    ph.push(t0 + 2000, 102);
    ph.push(t0, 999);
    expect(ph.toArray()[0]!.v).toBe(102);
  });
});

describe("PriceHistory — eviction jendela retensi", () => {
  it("sampel yang lebih tua dari jendela dibuang", () => {
    const ph = new PriceHistory(10 * 1000); // jendela 10 detik
    const t0 = Date.UTC(2026, 0, 2, 3, 0, 0);
    for (let s = 0; s < 30; s++) ph.push(t0 + s * 1000, 100 + s);
    // Hanya ~10 sampel terakhir yang boleh tersisa.
    expect(ph.size).toBeLessThanOrEqual(11);
    const arr = ph.toArray();
    expect(arr[arr.length - 1]!.v).toBe(129);
  });

  it("harga di dalam jendela tetap tersedia untuk firstSince", () => {
    const ph = new PriceHistory(HOUR);
    const t0 = Date.UTC(2026, 0, 2, 3, 0, 0);
    ph.push(t0, 100);
    ph.push(t0 + 30_000, 130);
    expect(ph.firstSince(t0 + 20_000)).toBe(130);
  });
});

describe("PriceHistory — seri harga untuk browser", () => {
  it("tidak menghasilkan duplikat timestamp (bug lama: 1.852 duplikat)", () => {
    const ph = new PriceHistory(3 * HOUR);
    const t0 = Date.UTC(2026, 0, 2, 3, 0, 0);
    // 15 menit, tiap detik ada 20 transaksi.
    for (let s = 0; s < 900; s++) {
      for (let i = 0; i < 20; i++) ph.push(t0 + s * 1000 + i, 80_000 + s);
    }
    const series = ph.seriesSince(t0, 3);
    const times = series.map((p) => p.t);
    expect(new Set(times).size).toBe(times.length);
  });

  it("resampling(step) mengurangi jumlah titik sesuai langkah", () => {
    const ph = new PriceHistory(3 * HOUR);
    const t0 = Date.UTC(2026, 0, 2, 3, 0, 0);
    for (let s = 0; s < 900; s++) ph.push(t0 + s * 1000, 80_000 + s);
    const step3 = ph.seriesSince(t0, 3);
    const step1 = ph.seriesSince(t0, 1);
    expect(step1.length).toBe(900);
    expect(step3.length).toBeLessThanOrEqual(300);
  });

  it("hanya mengembalikan sampel di dalam window", () => {
    const ph = new PriceHistory(3 * HOUR);
    const t0 = Date.UTC(2026, 0, 2, 3, 0, 0);
    for (let s = 0; s < 900; s++) ph.push(t0 + s * 1000, 80_000 + s);
    const last15 = ph.seriesSince(t0 + 840_000, 1);
    expect(last15.length).toBe(60);
  });
});

describe("PriceHistory — firstSince (awal window)", () => {
  it("mengembalikan harga pertama di dalam window", () => {
    const ph = new PriceHistory(3 * HOUR);
    const t0 = Date.UTC(2026, 0, 2, 3, 0, 0);
    ph.push(t0, 100);
    ph.push(t0 + 1000, 101);
    ph.push(t0 + 2000, 102);
    expect(ph.firstSince(t0 + 1000)).toBe(101);
  });

  it("null bila tidak ada sampel dalam window", () => {
    const ph = new PriceHistory(3 * HOUR);
    const t0 = Date.UTC(2026, 0, 2, 3, 0, 0);
    ph.push(t0, 100);
    expect(ph.firstSince(t0 + 10_000)).toBeNull();
  });

  it("null pada history kosong", () => {
    expect(new PriceHistory(HOUR).firstSince(0)).toBeNull();
  });
});

describe("PriceHistory — nilai tidak valid", () => {
  it("NaN / Infinity diabaikan", () => {
    const ph = new PriceHistory(3 * HOUR);
    const t0 = Date.UTC(2026, 0, 2, 3, 0, 0);
    ph.push(NaN, 100);
    ph.push(t0, NaN);
    ph.push(Infinity, 100);
    expect(ph.size).toBe(0);
  });
});
