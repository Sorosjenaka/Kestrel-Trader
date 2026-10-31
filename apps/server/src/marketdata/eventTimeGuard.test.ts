// apps/server/src/marketdata/eventTimeGuard.test.ts
// 25 Okt 2026 — regression test untuk pagar "anti lock buffer".
//
// Bug yang dipagari: satu transaksi dengan satuan waktu salah (nanosecond)
// mengunci buffer PERMANEN.
//   - PriceHistory: `lastSampleSec` = epoch-detik ~1.8e15 -> semua transaksi
//     nyata berikutnya punya sec lebih kecil -> DIABAIKAN -> seri harga ke
//     browser kosong selamanya.
//   - TimeRing: slot modulo capacity tertimpa acak, dan karena
//     `t >= fromSec` selalu true, notional+jumlah trade venue itu terhitung
//     di SETIAP window (1M/5M/15M/1H) sekaligus.
//
// Pagar: timestamp yang melebihi toleransi masa depan DITOLAK (tidak
// ditulis), sehingga buffer tidak pernah terkunci.
//
// CATATAN PENTING: pagar berbasis WALL-CLOCK, bukan `lastTimeSec`.
// Kalau pagar ini berbasis lastTimeSec (nilainya awal -1), pagar akan menolak SEMUA
// epoch-detik yang valid — test "sampel pertama tetap diterima" menjaga
// hal itu agar tidak terjadi lagi.
import { describe, expect, it } from "vitest";
import { PriceHistory } from "./priceHistory.js";
import { TimeRing } from "./timeSeries.js";

const NOW_MS = Date.now();
const NOW_SEC = Math.floor(NOW_MS / 1000);

describe("PriceHistory — pagar anti lock buffer", () => {
  it("sampel pertama dengan epoch valid TETAP diterima (pagar wall-clock)", () => {
    const ph = new PriceHistory(3 * 3600_000);
    ph.push(NOW_MS, 100);
    expect(ph.size).toBe(1);
  });

  it("timestamp nanosecond DITOLAK dan tidak mengunci buffer", () => {
    const ph = new PriceHistory(3 * 3600_000);
    // Transaksi salah satuan: 1.79e18 ms -> epoch-detik ~1.79e15.
    ph.push(1_792_902_798_229_000_000, 999);
    expect(ph.size).toBe(0);

    // Transaksi nyata sesudahnya HARUS tetap diterima.
    ph.push(NOW_MS, 100);
    expect(ph.size).toBe(1);
    expect(ph.toArray()[0]!.v).toBe(100);
  });

  it("skew kecil ke masa depan tetap diterima (drift bursa wajar)", () => {
    const ph = new PriceHistory(3 * 3600_000);
    ph.push(NOW_MS + 30_000, 100);
    expect(ph.size).toBe(1);
  });
});

describe("TimeRing — pagar anti lock buffer", () => {
  it("nilai pertama dengan epoch valid TETAP diterima", () => {
    const ring = new TimeRing(3600);
    ring.set(NOW_SEC, 42);
    expect(ring.get(NOW_SEC)).toBe(42);
  });

  it("timestamp nanosecond DITOLAK (tidak menabrak slot acak)", () => {
    const ring = new TimeRing(3600);
    const badSec = Math.floor(1_792_902_798_229_000_000 / 1000); // ~1.79e15
    ring.add(badSec, 1000);
    expect(ring.size).toBe(0);
    expect(ring.get(badSec)).toBe(0);
  });

  it("nilai window tidak bocor ke SEMUA window setelah ada transaksi valid", () => {
    const ring = new TimeRing(3600);
    // Transaksi valid di detik ini.
    ring.add(NOW_SEC, 100);
    // sumFrom untuk window 1 menit (from = now-60) harus memuat transaksi itu.
    expect(ring.sumFrom(NOW_SEC - 60)).toBe(100);
    // Window 1 menit TIDAK boleh melihat transaksi di detik yang sama lebih
    // dari sekali (sebelum fix, slot acak bisa tertulis di banyak slot).
    expect(ring.sumFrom(NOW_SEC - 3600)).toBe(100);
  });

  it("transaksi dengan satuan salah tidak menambah hitungan trade", () => {
    const ring = new TimeRing(3600);
    ring.add(Math.floor(1_792_902_798_229_000_000 / 1000), 1);
    expect(ring.size).toBe(0);
    expect(ring.sumFrom(0)).toBe(0);
  });
});
