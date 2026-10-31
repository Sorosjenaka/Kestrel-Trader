// apps/server/src/marketdata/priceHistory.ts
// 24 Okt 2026 — penyimpan seri harga ringkas (1 sampel per detik).
//
// LATAR BELAKANG (akar masalah "lambat banget"):
//   Versi lama menyimpan `priceHistory: {t, v}[]` dengan SATU entri PER
//   TRANSAKSI. Dengan ~280 transaksi/detik dari 10 venue, sesi 2 jam sudah
//   menampung ~2 juta objek per simbol, semuanya hidup di old-space V8.
//   Akibatnya (terverifikasi di VPS 24 Okt 2026):
//     - heap node ~1 GB di box 1.9 GB -> 653 MB ter-swap, 105 GB read_bytes;
//     - memory pressure `full avg10` = 29.6% (mesin stalled ~30% waktu);
//     - setiap snapshot memindai SELURUH array (O(n) = 2 juta iterasi),
//       dijalankan per klien SSE tiap 1.5 detik -> /api/orderflow/BTC 51 detik;
//     - seri harga ke browser jadi 3.941 titik dengan 1.852 DUPLIKAT timestamp.
//
//   Perbaikan: 1 sampel per detik. Harga chart tidak butuh resolusi
//   per-transaksi; 1 Hz sudah melebihi resolusi seri CVD (juga 1 Hz).
//   RAM per simbol: ~2 juta objek -> ~10.800 objek (jendela 3 jam).
//
// Data yang TIDAK hilang: harga di dalam 1 detik yang sama direpresentasikan
// oleh harga terakhir detik tersebut ("close" detik itu) — persis seperti
// candle OHLC 1 detik.

export interface PriceSample {
  /** epoch-ms waktu sampel (detik pertama yang di-representedasikan). */
  t: number;
  /** harga terakhir yang diketahui dalam detik tersebut. */
  v: number;
}

/**
 * 25 Okt 2026 — toleransi skew masa depan (detik).
 *
 * Transaksi dengan satuan waktu yang salah (mis. nanosecond) menghasilkan
 * epoch-detik ~1.8e15. Kalau tidak dipagari, satu transaksi seperti itu
 * mengunci seluruh buffer. Pagar ini mencegah buffer terkunci permanen.
 *
 * Basis WALL-CLOCK, bukan `lastSampleSec`: yang terakhir awalnya -1, sehingga
 * pagar berbasisnya akan menolak SEMUA epoch-detik yang valid.
 */
const MAX_FUTURE_SKEW_SEC = 90;

export class PriceHistory {
  private readonly samples: PriceSample[] = [];
  /** epoch-detik dari sampel terakhir yang ditulis; -1 = belum ada. */
  private lastSampleSec = -1;

  constructor(private readonly windowMs: number) {}

  /**
   * Catat harga pada waktu `t` (epoch-ms).
   * - Detik baru  -> entri baru (maks 1 per detik).
   * - Detik sama  -> perbarui harga entri terakhir (harga "close" detik itu).
   * - Detik lama  -> DIABAIKAN (transaksi terlambat/out-of-order; inserting
   *   akan merusak urutan waktu dan membuat garis harga di chart zigzag).
   *
   * 25 Okt 2026 — PAGAR MASA DEPAN. Timestamp yang jauh di masa depan
   * (satuan salah, mis. nanosecond yang tidak dinormalisasi) SEBELUMNYA
   * mengunci `lastSampleSec` selamanya: setiap transaksi nyata berikutnya
   * punya sec lebih kecil -> diabaikan -> priceHistory terkunci pada satu
   * sampel dan seri harga ke browser jadi kosong. Sekarang timestamp yang
   * melebihi toleransi masa depan DITOLAK, bukan mengunci buffer.
   */
  push(t: number, v: number): void {
    if (!Number.isFinite(t) || !Number.isFinite(v)) return;
    const sec = Math.floor(t / 1000);
    // Pagar masa depan (wall-clock): tolak timestamp yang jelas salah satuan.
    if (sec > Math.floor(Date.now() / 1000) + MAX_FUTURE_SKEW_SEC) return;
    if (sec > this.lastSampleSec) {
      this.lastSampleSec = sec;
      this.samples.push({ t, v });
      this.evictExpired(t);
    } else if (sec === this.lastSampleSec) {
      const last = this.samples[this.samples.length - 1];
      if (last) last.v = v;
    }
  }

  /** Buang sampel yang sudah melewati jendela retensi. */
  private evictExpired(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    let drop = 0;
    while (drop < this.samples.length && this.samples[drop]!.t < cutoff) drop++;
    // splice() sekali jalan, bukan shift() per elemen — shift() pada array
    // besar itu O(n) dan menggeser seluruh isi tiap kali.
    if (drop > 0) this.samples.splice(0, drop);
  }

  /** Jumlah sampel yang tersimpan. */
  get size(): number {
    return this.samples.length;
  }

  /** Epoch-detik dari sampel terakhir (untuk logika "detik baru"). */
  get lastSec(): number {
    return this.lastSampleSec;
  }

  /**
   * Sampel pertama dengan t >= fromMs, atau null.
   * Dipakai untuk menghitung % perubahan harga pada sebuah window.
   */
  firstSince(fromMs: number): number | null {
    // Sampel terurut menaik, jadi cari via binary search.
    let lo = 0;
    let hi = this.samples.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = this.samples[mid]!;
      if (s.t < fromMs) lo = mid + 1;
      else { hi = mid - 1; }
    }
    return this.samples[lo] ? this.samples[lo]!.v : null;
  }

  /**
   * Seri harga pada window [fromMs, ∞), disampling ulang ke 1 titik per
   * `stepSec` detik. Timestamp unik — tidak ada duplikat (versi lama
   * menghasilkan 1.852 duplikat pada window 15 menit karena setiap transaksi
   * di-push).
   */
  seriesSince(fromMs: number, stepSec: number): PriceSample[] {
    const step = Math.max(1, Math.floor(stepSec));
    const out: PriceSample[] = [];
    for (const s of this.samples) {
      if (s.t < fromMs) continue;
      if (Math.floor(s.t / 1000) % step === 0) out.push(s);
    }
    return out;
  }

  /** Salinan array sampel (untuk testing/diagnostik). */
  toArray(): PriceSample[] {
    return this.samples.map((s) => ({ t: s.t, v: s.v }));
  }
}
