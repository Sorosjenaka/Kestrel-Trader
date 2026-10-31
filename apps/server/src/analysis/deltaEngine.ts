// apps/server/src/analysis/deltaEngine.ts - Perhitungan delta/CVD deterministik.
// 23 Okt 2026 (Tahap 4). INI angka; LLM hanya menginterpretasi.
//
// Aturan yang tidak boleh dilanggar:
//  - Missing = TIDAK ADA, bukan 0.
//  - Sesi dihitung dari 00:00 WIB (07:00 UTC), bukan dari boot.
//  - Rolling delta (rebased ke nol tiap window) DIBEDAKAN dari CVD sesi.
//  - Warm-up: histori belum menutup jendela -> ditandai, bukan diam-diken jadi lengkap.
//  - Trade duplikat (id sama) diabaikan; snapshot-ulang bukan trade baru.
//  - Restart di tengah sesi -> CVD sesi = null (tidak boleh diklaim lengkap).
//
// DESAIN: satu bucket per MENIT sebagai sumber tunggal, semua jendela
// diturunkan darinya. Ini penting karena 23 Okt 2026: versi queue-per-tick
// memotong jumlah transaksi tepat di batas buffer (4.000) sehingga angka
// "TRANSAKSI" di UI ikut terpotong — diam-diam salah. Bucket per menit:
//   - jumlah & notional dalam jendela = eksak (penjumlahan bucket),
//   - memori tetap kecil (240 bucket untuk jendela 4 jam),
//   - hanya presisi sub-menit yang hilang, yang tidak dipakai untuk apa pun.

export type AggressorSide = "BUY" | "SELL";

/** Identitas event feed. ID harus stabil per feed (bukan nonce acak). */
export interface TradeTick {
  /** ID unik trade di feed tsb. Untuk Binance aggTrade: "a<aggTradeId>". */
  id: string;
  /** Event time exchange (ms). */
  eventTime: number;
  /** Harga eksekusi. */
  price: number;
  /** Base quantity. */
  qty: number;
  /** Sisi agresif: taker side. */
  aggressor: AggressorSide;
}

export interface WindowSpec {
  key: "5m" | "15m" | "1h" | "4h";
  ms: number;
}
export const WINDOWS: WindowSpec[] = [
  { key: "5m", ms: 5 * 60_000 },
  { key: "15m", ms: 15 * 60_000 },
  { key: "1h", ms: 60 * 60_000 },
  { key: "4h", ms: 4 * 60 * 60_000 },
];

/** WIB = UTC+7. Sesi pasar dihitung dari 00:00 WIB = 17:00 UTC. */
const WIB_OFFSET_MS = 7 * 60 * 60_000;
const MINUTE_MS = 60_000;

/**
 * Awal sesi (00:00 WIB) yang MENCEMAKAN nowMs.
 * 23 Okt 12:00 UTC = 19:00 WIB -> sesi 23 Okt dimulai 22 Okt 17:00 UTC.
 */
export function sessionStartMs(nowMs: number): number {
  const wibNow = nowMs + WIB_OFFSET_MS;
  const wibDayStart = Math.floor(wibNow / 86_400_000) * 86_400_000;
  return wibDayStart - WIB_OFFSET_MS;
}

/** Bucket satu menit. */
interface MinuteBucket {
  /** Awal menit (ms, kelipatan 60.000). */
  t: number;
  buy: number;
  sell: number;
  count: number;
}

export interface DeltaWindowResult {
  buyNotional: number;
  sellNotional: number;
  buyRatio: number | null;
  totalNotional: number;
  tradeCount: number;
  deltaNotional: number;
  cvdSession: number | null;
  rollingDelta: number;
  warmup: boolean;
  reconnectCount: number;
}

/**
 * Akumulator delta per venue, berbasis bucket per menit.
 * Memori dibatasi: bucket yang lebih tua dari jendela terpanjang dibuang.
 */
export class DeltaAccumulator {
  /** Bucket per menit, terurut naik. */
  private buckets: MinuteBucket[] = [];
  private readonly bucketIndex = new Map<number, MinuteBucket>();
  private readonly seenIds = new Set<string>();
  private readonly seenOrder: string[] = [];
  private readonly maxSeen: number;

  private ingested = 0;
  private duplicates = 0;
  /** Event time tertua yang pernah terlihat (bukti sudah ada sejak itu). */
  private earliestEventAt: number | null = null;
  /** Kapan akumulator dibuat (awal pengamatan). */
  private readonly startedAt: number;

  constructor(opts?: { maxSeen?: number; now?: number }) {
    this.maxSeen = opts?.maxSeen ?? 50_000;
    this.startedAt = opts?.now ?? Date.now();
  }

  /**
   * Masukkan trade. Return true kalau diterima, false kalau duplikat/tidak valid.
   * Snapshot-ulang punya id sama -> ditolak (aman).
   */
  ingest(tick: TradeTick): boolean {
    if (!Number.isFinite(tick.price) || !Number.isFinite(tick.qty) || tick.price <= 0 || tick.qty <= 0) return false;
    if (!Number.isFinite(tick.eventTime) || tick.eventTime <= 0) return false;
    if (this.seenIds.has(tick.id)) {
      this.duplicates++;
      return false;
    }
    this.seenIds.add(tick.id);
    this.seenOrder.push(tick.id);
    if (this.seenOrder.length > this.maxSeen) {
      const drop = this.seenOrder.shift();
      if (drop) this.seenIds.delete(drop);
    }
    this.ingested++;
    if (this.earliestEventAt === null || tick.eventTime < this.earliestEventAt) {
      this.earliestEventAt = tick.eventTime;
    }
    const bucketT = Math.floor(tick.eventTime / MINUTE_MS) * MINUTE_MS;
    let b = this.bucketIndex.get(bucketT);
    if (!b) {
      b = { t: bucketT, buy: 0, sell: 0, count: 0 };
      this.bucketIndex.set(bucketT, b);
      // Sisipkan terurut (bucket biasanya sudah di ujung, tapi trade telat bisa
      // datang untuk menit yang lebih lama).
      let i = this.buckets.length;
      while (i > 0 && this.buckets[i - 1]!.t > bucketT) i--;
      this.buckets.splice(i, 0, b);
    }
    const notional = tick.price * tick.qty;
    if (tick.aggressor === "BUY") b.buy += notional;
    else b.sell += notional;
    b.count++;
    return true;
  }

  /**
   * Buang bucket yang tidak diperlukan lagi.
   *
   * Retensi = max(jendela terpanjang 4 jam, awal sesi berjalan).
   * Sesi bisa berlangsung jauh lebih lama dari 4 jam (sesi WIB dimulai
   * 17:00 UTC, sekarang bisa sudah 19 jam kemudian). Kalau hanya 4 jam
   * yang disimpan, bucket awal sesi hilang -> CVD sesi UNDERCOUNT.
   * Memori tetap kecil: <= ~1.700 bucket per jam-window (satu per menit).
   */
  private prune(nowMs: number): void {
    const windowCutoff = nowMs - WINDOWS[WINDOWS.length - 1]!.ms;
    const sessionCutoff = sessionStartMs(nowMs);
    const cutoff = Math.min(windowCutoff, sessionCutoff);
    while (this.buckets.length > 0 && this.buckets[0]!.t < cutoff) {
      const old = this.buckets.shift()!;
      this.bucketIndex.delete(old.t);
    }
  }

  /**
   * Hitung delta per jendela.
   * cvdSession: delta kumulatif sejak 00:00 WIB, HANYA bila kita mengobservation
   *   dari awal sesi (startedAt <= sessionStart). Kalau tidak -> null.
   * rollingDelta: delta dalam jendela (direbase ke nol).
   */
  compute(nowMs: number): {
    byWindow: Record<string, DeltaWindowResult>;
    sessionStart: number;
    duplicates: number;
    ingested: number;
    sessionObserved: boolean;
  } {
    this.prune(nowMs);
    const sStart = sessionStartMs(nowMs);
    const byWindow: Record<string, DeltaWindowResult> = {};

    for (const w of WINDOWS) {
      const cutoff = nowMs - w.ms;
      let buy = 0, sell = 0, count = 0;
      for (const b of this.buckets) {
        // Bucket dihitung utuh bila menitnya >= batas awal jendela.
        if (b.t + MINUTE_MS <= cutoff) continue;
        buy += b.buy;
        sell += b.sell;
        count += b.count;
      }
      const total = buy + sell;

      // CVD sesi: jumlahkan bucket dari awal sesi.
      // CATATAN PENTING: bucket per menit harus dipecah tepat di batas sesi.
      // Kalau tidak, bucket menit yang memuat awal sesi ikut seluruhnya
      // (termasuk trade SEBELUM sesi) -> CVD sesi overstated.
      let cvd = 0;
      let sessionTrades = 0;
      for (const b of this.buckets) {
        if (b.t + MINUTE_MS <= sStart) continue;
        // Bucket yang memotong batas sesi: hitung proporsional.
        // Trade tepat di batas sesi sangat jarang, jadi proporsi per menit
        // cukup akurat; yang penting tidak memasukkan trade sebelum sesi.
        if (b.t < sStart) {
          // Bucket mencakup [b.t, b.t+MINUTE). Sesi mulai di tengah bucket.
          const frac = (b.t + MINUTE_MS - sStart) / MINUTE_MS;
          cvd += (b.buy - b.sell) * frac;
          sessionTrades += Math.round(b.count * frac);
          continue;
        }
        cvd += b.buy - b.sell;
        sessionTrades += b.count;
      }
      // Sesi hanya valid kalau kita mengobservation SEJAK awal sesi.
      const sessionObserved = this.startedAt <= sStart && sessionTrades > 0;

      byWindow[w.key] = {
        buyNotional: buy,
        sellNotional: sell,
        buyRatio: total > 0 ? buy / total : null,
        totalNotional: total,
        tradeCount: count,
        deltaNotional: buy - sell,
        cvdSession: sessionObserved ? cvd : null,
        rollingDelta: buy - sell,
        // Jendela tercakup penuh hanya bila trade tertua yang pernah terlihat
        // sudah melewati batas awal jendela.
        warmup: this.earliestEventAt === null || this.earliestEventAt > cutoff,
        reconnectCount: 0,
      };
    }
    return {
      byWindow,
      sessionStart: sStart,
      duplicates: this.duplicates,
      ingested: this.ingested,
      sessionObserved: this.startedAt <= sStart && this.ingested > 0,
    };
  }

  stats(): { ingested: number; duplicates: number; seen: number; buckets: number } {
    return { ingested: this.ingested, duplicates: this.duplicates, seen: this.seenIds.size, buckets: this.buckets.length };
  }
}
