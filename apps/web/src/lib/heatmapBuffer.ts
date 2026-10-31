// apps/web/src/lib/heatmapBuffer.ts
// BUFFER HEATMAP ORDER BOOK (audit 14 Okt 2026) — modul MURNI tanpa React/DOM
// agar bisa di-unit-test. Kebijakan yang DOKUMENTASI:
//
// 1. SUMBER DATA: snapshot REST /api/binance/depth (fapi/v1/depth) tiap 2 dtk.
//    Tidak ada data karangan — bucket tanpa observasi tetap KOSONG.
// 2. BIN HARGA: simpan mid saat snapshot; render bounds absolut di satu sumbu.
// 3. WAKTU: kolom = bucket waktu tetap SNAPSHOT_MS (2 dtk). Kolom tanpa
//    snapshot (fetch telat/gagal) = kosong — TIDAK diinterpolasi.
// 4. Dinding yang ditarik tetap ada hanya di kolom historisnya. Snapshot baru
//    berisi observasi baru saja; tidak ada decay atau carry antar snapshot.
// 5. NORMALISASI: intensitas = sqrt(v / P95) — memakai persentil-95 window,
//    bukan max, supaya 1 dinding raksasa tidak mempipihkan skala. v > P95 → clamp 1.
// 6. RETENSI: buffer dipangkas > WINDOW_MS; kapasitas kolom = WINDOW_MS/2s = 450.

export const SNAPSHOT_MS = 2000;
export const WINDOW_MS = 15 * 60_000; // jendela historis 15 menit (scalping 1m)
export const ROWS = 40;               // bin harga: 20 bid di bawah mid, 20 ask di atas
export const RANGE_PCT = 0.8;         // jangkauan ±0.8% dari mid
export const DECAY_HALF_LIFE_BUCKETS = 15; // half-life 30 dtk (15 bucket × 2 dtk)
const HALF = ROWS / 2;

export interface DepthSide { bids: [string, string][]; asks: [string, string][] }

/** Satu kolom waktu: nilai notional per bin + side bin + mid saat itu. */
export interface HeatColumn {
  t: number;                 // epoch ms bucket
  mid: number;
  values: Float64Array;      // notional USD per bin (belum dinormalisasi)
  isBid: Uint8Array;
  /** Timestamp observasi terakhir per bin — untuk hitung umur/decay & hover. */
  lastSeen: Float64Array;
}

export class HeatmapBuffer {
  private cols = new Map<number, HeatColumn>(); // key = bucket timestamp
  private latestMid = 0;
  private lastSnapshotAt = 0;

  /** Masukkan satu snapshot depth. Waktu bucket = pembulatan SNAPSHOT_MS. */
  pushSnapshot(t: number, mid: number, depth: DepthSide): HeatColumn {
    if (!Number.isFinite(t) || !Number.isFinite(mid) || t <= 0 || mid <= 0) throw new Error("Invalid heatmap snapshot");
    const bucket = Math.floor(t / SNAPSHOT_MS) * SNAPSHOT_MS;
    const values = new Float64Array(ROWS);
    const isBid = new Uint8Array(ROWS);
    const lastSeen = new Float64Array(ROWS);
    if (mid > 0) {
      const add = (rows: [string, string][], below: boolean) => {
        for (const [p, q] of rows) {
          const price = Number(p), qty = Number(q);
          if (!Number.isFinite(price) || !Number.isFinite(qty) || !(price > 0) || !(qty > 0)) continue;
          const dist = ((price - mid) / mid) * 100;
          if ((below && dist > 0) || (!below && dist < 0) || Math.abs(dist) >= RANGE_PCT) continue;
          const offset = Math.floor(Math.abs(dist) / RANGE_PCT * HALF);
          const idx = below ? HALF - 1 - offset : HALF + offset;
          if (idx >= 0 && idx < ROWS) {
            values[idx] += price * qty; // notional USD
            isBid[idx] = below ? 1 : 0;
            lastSeen[idx] = t;
          }
        }
      };
      add(depth.bids, true);
      add(depth.asks, false);
    }
    const col: HeatColumn = { t: bucket, mid, values, isBid, lastSeen };
    // A removed wall remains in its historical column only. Never copy it
    // into a fresh snapshot (especially after the mid-price has changed).
    this.cols.set(bucket, col);
    if (mid > 0) this.latestMid = mid;
    this.lastSnapshotAt = t;
    this.prune(t);
    return col;
  }

  /** Buang kolom di luar jendela + kolom kosong total di awal (tanpa data). */
  prune(now = Date.now()): void {
    const cutoff = now - WINDOW_MS;
    for (const [k, c] of this.cols) if (k < cutoff) this.cols.delete(k);
  }

  columns(): HeatColumn[] {
    return [...this.cols.values()].sort((a, b) => a.t - b.t);
  }

  get mid(): number { return this.latestMid; }
  get lastAt(): number { return this.lastSnapshotAt; }
  get length(): number { return this.cols.size; }

  /**
   * Persentil-95 dari semua nilai non-nol (basis normalisasi).
   * Array kecil (≤ 450×40) — sort sederhana cukup dan deterministik.
   */
  p95(): number {
    const vals: number[] = [];
    for (const c of this.cols.values()) for (let i = 0; i < ROWS; i++) if (c.values[i]! > 0) vals.push(c.values[i]!);
    if (vals.length === 0) return 0;
    vals.sort((a, b) => a - b);
    return vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.95))]!;
  }

  /** Map kolom → intensitas 0..1 dengan normalisasi P95 + skala akar. */
  intensityGrid(): { cols: HeatColumn[]; p95: number } {
    const cols = this.columns();
    const p95 = this.p95();
    return { cols, p95 };
  }

  /**
   * Persistensi riwayat (audit 14 Okt 2026): simpan kolom ke storage agar
   * refresh halaman TIDAK menghapus riwayat 15 menit yang sudah terkumpul.
   * Hanya kolom ≤ WINDOW_MS yang disimpan; data kosong tetap kosong.
   */
  serialize(): string {
    return JSON.stringify(
      { version: 2, columns: this.columns().map((c) => ({
        t: c.t, mid: c.mid,
        v: Array.from(c.values),
        b: Array.from(c.isBid),
        l: Array.from(c.lastSeen),
      })) },
    );
  }

  /** Pulihkan dari serialize() — kolom lama tetap tunduk prune(WINDOW_MS). */
  restore(json: string): void {
    try {
      const payload = JSON.parse(json);
      if (payload?.version !== 2) return; // Legacy snapshots contain synthetic carried walls.
      const arr = payload.columns as { t: number; mid: number; v: number[]; b: number[]; l: number[] }[];
      if (!Array.isArray(arr)) return;
      for (const c of arr) {
        if (!c || !Number.isFinite(c.t) || !Number.isFinite(c.mid) || !(c.t > 0) || !(c.mid > 0)
          || c.t > Date.now() + SNAPSHOT_MS || !Array.isArray(c.v) || !Array.isArray(c.b) || !Array.isArray(c.l)) continue;
        const values = new Float64Array(ROWS);
        const isBid = new Uint8Array(ROWS);
        const lastSeen = new Float64Array(ROWS);
        for (let i = 0; i < ROWS; i++) {
          values[i] = Number.isFinite(c.v[i]) && c.v[i]! > 0 ? c.v[i]! : 0;
          isBid[i] = c.b[i] ? 1 : 0;
          lastSeen[i] = Number(c.l[i]) || c.t;
        }
        this.cols.set(c.t, { t: c.t, mid: c.mid, values, isBid, lastSeen });
      }
      this.prune();
      const last = this.columns().at(-1);
      this.latestMid = last?.mid ?? 0;
      this.lastSnapshotAt = last?.t ?? 0;
    } catch {
      // storage rusak → mulai dari nol, jangan error
    }
  }
}

/** Shared absolute-price geometry for drawing and hit testing. */
export function binPriceBounds(mid: number, idx: number): [number, number] {
  const { side, row } = binRowFromMid(idx);
  const step = RANGE_PCT / HALF / 100;
  return side === "bid"
    ? [mid * (1 - (row + 1) * step), mid * (1 - row * step)]
    : [mid * (1 + row * step), mid * (1 + (row + 1) * step)];
}

export function priceY(price: number, mid: number, height: number): number {
  return (1 - (price / mid - 1) / (RANGE_PCT / 100)) * height / 2;
}

/** Arahkan indeks bin → offset baris dari mid (0 = tepat di sebelah mid). */
export function binRowFromMid(idx: number): { side: "bid" | "ask"; row: number } {
  return idx < HALF ? { side: "bid", row: HALF - 1 - idx } : { side: "ask", row: idx - HALF };
}

/** Hitung decay faktor berdasarkan umur (bucket) — untuk hover/aging display. */
export function decayFactor(ageBuckets: number): number {
  return Math.pow(0.5, ageBuckets / DECAY_HALF_LIFE_BUCKETS);
}
