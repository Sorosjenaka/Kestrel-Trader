// apps/server/src/marketdata/timeSeries.ts
// Ring buffer numerik untuk time-series high-frequency (CVD, taker buy/sell,
// tier aggregates). Dipakai supaya RAM VPS tetap kecil: array primitif
// (Float64Array) alih-alih ribuan objek {t, v} yang allocating GC keras.
//
// Invarian: slot menyimpan agregat PER DETIK / PER MENIT. Index = waktu
// epoch-detik. Nilai di slot yang "lewat" (gap tanpa trade) = 0, BUKAN
// carry-forward — jadi delta yang hilang tidak pernah dipalsukan.

export class TimeRing {
  private readonly values: Float64Array;
  private readonly times: Float64Array;
  private head = 0;
  private filled = 0;
  private lastTimeSec = -1;

  constructor(readonly capacity: number) {
    this.values = new Float64Array(capacity);
    this.times = new Float64Array(capacity);
  }

  /**
   * 25 Okt 2026 — pagar masa depan, berbasis WALL-CLOCK (bukan lastTimeSec).
   *
   * Tanpa pagar ini, satu transaksi dengan satuan waktu salah (mis. KuCoin
   * nanosecond -> epoch-detik ~1.8e15) menabrak slot modulo capacity secara
   * acak DAN karena `t >= fromSec` selalu true, notional+jumlah trade venue
   * itu terhitung di SETIAP window (1M, 5M, 15M, 1H) sekaligus. Akibatnya
   * data window 1M/5M/15M/1H tidak pernah bisa keluar.
   *
   * Basis wall-clock (bukan `lastTimeSec`) dipilih supaya pagar tetap berlaku
   * pada slot pertama — `lastTimeSec` awalnya -1, sehingga pagarnya berbasis
   * itu akan menolak SEMUA epoch-detik yang valid.
   */
  private static readonly MAX_FUTURE_SKEW_SEC = 90;

  /** Epoch-detik "sekarang" menurut wall-clock. */
  private static nowSec(): number {
    return Math.floor(Date.now() / 1000);
  }

  /** true = timestamp jauh di masa depan -> tolak. */
  private static tooFarFuture(sec: number): boolean {
    return sec > TimeRing.nowSec() + TimeRing.MAX_FUTURE_SKEW_SEC;
  }

  /** capacity efektif (slot yang terisi). */
  get size(): number {
    return this.filled;
  }

  /** epoch-detik terakhir yang ditulis. */
  get lastSec(): number {
    return this.lastTimeSec;
  }

  /**
   * Tulis nilai pada waktu epoch-detik `sec`. Nilai SEBELUM slot ini
   * ditimpa tetap utuh (riwayat), hanya slot yang sama ditulis ulang.
   */
  set(sec: number, value: number): void {
    if (!Number.isFinite(sec) || !Number.isFinite(value)) return;
    if (TimeRing.tooFarFuture(sec)) return; // pagar
    const slot = ((sec % this.capacity) + this.capacity) % this.capacity;
    const isNewSlot = this.times[slot] !== sec;
    this.times[slot] = sec;
    this.values[slot] = value;
    if (isNewSlot) this.filled = Math.min(this.capacity, this.filled + 1);
    if (sec > this.lastTimeSec) this.lastTimeSec = sec;
  }

  /** Tambah (akumulasi) nilai pada waktu epoch-detik `sec`. */
  add(sec: number, delta: number): void {
    if (!Number.isFinite(sec) || !Number.isFinite(delta) || delta === 0) return;
    if (TimeRing.tooFarFuture(sec)) return; // pagar
    const slot = ((sec % this.capacity) + this.capacity) % this.capacity;
    if (this.times[slot] !== sec) {
      this.times[slot] = sec;
      this.values[slot] = 0;
      if (this.lastTimeSec < 0 || sec > this.lastTimeSec) this.lastTimeSec = sec;
      this.filled = Math.min(this.capacity, this.filled + 1);
    }
    this.values[slot] += delta;
  }

  /** Nilai pada waktu epoch-detik (0 bila tidak ada). */
  get(sec: number): number {
    const slot = ((sec % this.capacity) + this.capacity) % this.capacity;
    if (this.times[slot] !== sec) return 0;
    return this.values[slot]!;
  }

  /** Jumlah nilai pada slot yang waktunya >= `fromSec`. */
  sumFrom(fromSec: number): number {
    let total = 0;
    for (let i = 0; i < this.capacity; i++) {
      const t = this.times[i]!;
      if (t >= fromSec && t > 0) total += this.values[i]!;
    }
    return total;
  }

  /** Poin (t, v) untuk slot yang waktunya >= `fromSec`, terurut menaik. */
  pointsFrom(fromSec: number): { t: number; v: number }[] {
    const out: { t: number; v: number }[] = [];
    for (let i = 0; i < this.capacity; i++) {
      const t = this.times[i]!;
      if (t >= fromSec && t > 0) out.push({ t, v: this.values[i]! });
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  /** Slot tertua yang masih tersimpan. */
  oldestSec(): number {
    let min = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.capacity; i++) {
      const t = this.times[i]!;
      if (t > 0 && t < min) min = t;
    }
    return min === Number.POSITIVE_INFINITY ? 0 : min;
  }
}

/**
 * Deret waktu BERJALAN per-detik: menyimpan nilai terakhir yang diketahui
 * untuk setiap detik sejak epoch `startSec`. Dipakai untuk seri CVD (yang
 * nilainya kumulatif) — nilainya di-forward-kan, bukan dijumlahkan.
 */
export class CumulativeSeries {
  private readonly values: Float64Array;
  private readonly times: Float64Array;
  private head = 0;
  private filled = 0;
  private lastTimeSec = -1;

  constructor(readonly capacity: number) {
    this.values = new Float64Array(capacity);
    this.times = new Float64Array(capacity);
  }

  get size(): number {
    return this.filled;
  }

  get lastSec(): number {
    return this.lastTimeSec;
  }

  /** Tulis (ganti) nilai kumulatif pada waktu epoch-detik. */
  set(sec: number, value: number): void {
    if (!Number.isFinite(sec) || !Number.isFinite(value)) return;
    if (this.lastTimeSec >= 0 && sec < this.lastTimeSec) return; // tidak mundur
    const slot = ((sec % this.capacity) + this.capacity) % this.capacity;
    if (this.times[slot] !== sec) {
      this.times[slot] = sec;
      this.values[slot] = value;
      this.filled = Math.min(this.capacity, this.filled + 1);
    } else {
      this.values[slot] = value;
    }
    this.lastTimeSec = sec;
  }

  /** Poin (t, v) dengan waktu >= fromSec, terurut menaik. */
  pointsFrom(fromSec: number): { t: number; v: number }[] {
    const out: { t: number; v: number }[] = [];
    for (let i = 0; i < this.capacity; i++) {
      const t = this.times[i]!;
      if (t >= fromSec && t > 0) out.push({ t, v: this.values[i]! });
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }
}
