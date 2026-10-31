// apps/server/src/engines/fibRetracementEngine.ts
// DETECTOR SETUP FIBONACCI ZONE 0.5-0.618 (S-03, renumber 6 Okt 2026;
// ZONA ENTRY 7 Okt 2026 atas perintah operator).
//
// Mesin deterministik murni (tanpa I/O, tanpa angka uang) yang mendeteksi setup
// retracement Fibonacci pada leg swing setelah Break of Structure. Logika
// deteksi 1:1 dengan engine riset fib0618_backtest.py (anti-lookahead,
// FEE_RATE=0); varian zona diuji 7 Okt 2026 di fib_zone_backtest.py
// (BTC/USDT M5, 540 hari): entry zona 0.5-0.618 + TP dipaksa 1.5R positif
// di kedua bound intrabar (PF 1.008-1.026, WR ~40,6%).
//
// ATURAN ANTI-LOOKAHEAD (wajib, dari spesifikasi riset):
//  - Semua keputusan memakai candle yang SUDAH TUTUP. Bar terakhir pada data
//    live (klines Binance selalu menyertakan candle yang sedang berjalan)
//    TIDAK dipakai untuk deteksi kecuali opsi includeLastBar (uji/backtest).
//  - Pivot swing N=4 baru SAH dipakai SETELAH N bar sesudahnya tutup
//    (delay konfirmasi N bar) — pivot tidak pernah dipakai saat baru muncul.
//
// GEOMETRI LEVEL (dihitung kode dari leg, tidak pernah dari LLM):
//   LONG  setelah close > swing high:  Lp = swing low, Hs = ekstrem high leg.
//         entry  = Hs - 0.5*(Hs-Lp)     (level 0.5 = batas zona 0.5-0.618
//                                        yang tersentuh pertama; harga yang
//                                        retrace selalu melewati 0.5 sebelum
//                                        0.618, jadi first-touch zona = 0.5)
//         SL     = Lp                   (level 1.0)
//         TP     = dipaksa 1.5R dari entry (bukan level 0.0 struktural;
//                angka resmi tp1R ada di setupEngine.strategyGateOverrides).
//   SHORT (cermin): entry = Lp + 0.5*(Hs-Lp), SL = Hs, TP = fill - 1.5R.
//   RR natural level 0.5 = 1.0; RR DIPAKSA 1.5 (keputusan operator 7 Okt 2026,
//   satu-satunya varian zona yang positif di kedua bound backtest).
//
// FSM persis riset: IDLE -> ARMED (menunggu harga menyentuh zona entry) ->
// batal (harga tembus level 1.0 atau level 0.0 duluan) / terpakai.
// Leg yang sudah menyentuh level entry dianggap TERPAKAI (tidak di-arm ulang)
// sampai ada BOS baru — mencegah entry ganda pada leg yang sama.
import type { Bar } from "../universe/eligibility.js";

/** Fraksi retracement batas zona entry (first-touch zona 0.5-0.618). */
export const FIB_ENTRY_RATIO = 0.5;
export const FIB_PIVOT_N = 4; // 7 Okt 2026: N=5 -> N=4 (perintah operator; backtest 540 hari N=4 PF 1.040/1.041, lebih baik dari N=5)
/**
 * RR target dipaksa (referensi; angka resmi tp1R ada di setupEngine).
 * 21 Okt 2026 (Phase 4g): un-export — tidak ada konsumen di repo
 * (hanya dirujuk di komentar mrvStretchEngine). Angka resmi tetap di setupEngine.
 */
const FIB_RR = 1.5;

export interface FibRetracementSetup {
  side: "LONG" | "SHORT";
  /** Level 0.5 (batas zona 0.5-0.618) — harga entry yang ditunggu. */
  entryLevel: number;
  /** Level 1.0 — ekstrem swing, tempat SL (tidak pernah digeser). */
  slLevel: number;
  /** Level 0.0 — asal swing, tempat TP. */
  tpLevel: number;
  /** Lebar leg (Hs - Lp). */
  range: number;
  swingHigh: number;
  swingLow: number;
  /** Indeks bar pivot (untuk audit; pivot HIGH dipakai sbg penanda leg LONG). */
  swingHighIdx: number;
  swingLowIdx: number;
  /** Indeks bar yang menutup dengan break of structure. */
  bosIdx: number;
  /** Jumlah bar sejak BOS sampai bar terakhir yang dipakai deteksi. */
  barsSinceBos: number;
}

export interface FibDetectOptions {
  /** Override window pivot (default FIB_PIVOT_N=4; pre-registrasi riset). */
  pivotN?: number;
  /**
   * true = bar terakhir ikut dipakai (data backtest yang semuanya sudah tutup).
   * Default false: live klines menyertakan candle yang sedang berjalan.
   */
  includeLastBar?: boolean;
  /**
   * true = ekstrem swing (pivot high/low & ekstrem leg Hs/Lp) dihitung dari
   * HARGA CLOSE candle, bukan wick high/low — zona fibo 0.5-0.618 berbasis
   * close (perintah operator 14 Okt 2026 untuk lane SWING). FSM sentuh/invalid
   * tetap memakai high/low asli (bound pesimis tidak berubah). Default false
   * agar paritas 1:1 dengan engine riset fib0618_backtest.py tetap utuh.
   */
  closeBased?: boolean;
}

interface Pivot { price: number; idx: number }

/**
 * Deteksi setup Fib zona 0.5-0.618 pada jendela bar tertutup.
 * Mengembalikan leg yang SEDANG ARMED (level entry belum tersentuh, belum
 * invalid), atau null bila tidak ada setup hidup.
 */
export function detectFibRetracement(bars: Bar[], options: FibDetectOptions = {}): FibRetracementSetup | null {
  const N = options.pivotN ?? FIB_PIVOT_N;
  const n = bars.length;
  const end = options.includeLastBar ? n : n - 1; // batas eksklusif bar yang dipakai
  if (N < 1 || end < 2 * N + 3) return null;

  const h = bars.map((b) => b.high);
  const l = bars.map((b) => b.low);
  const c = bars.map((b) => b.close);
  // closeBased (14 Okt 2026, lane SWING): GEOMETRI (pivot + ekstrem leg Hs/Lp)
  // dari close; FSM sentuh/invalidasi tetap pakai wick asli (bound pesimis utuh).
  const hg = options.closeBased ? c : h;
  const lg = options.closeBased ? c : l;

  // Registrasi pivot: pivot di bar j (N <= j <= i-N) dikonfirmasi di bar i=j+N,
  // dengan syarat ekstremnya unik di window [j-N, j+N] (anti-lookahead).
  const phc: (number | null)[] = new Array(n).fill(null); // phc[i] = harga swing high terkonfirmasi di bar i
  const plc: (number | null)[] = new Array(n).fill(null);
  for (let i = N; i < end; i++) {
    const j = i - N; // kandidat pivot
    if (j < N) continue;
    let maxH = -Infinity, minL = Infinity, maxCount = 0, minCount = 0;
    for (let k = j - N; k <= j + N; k++) {
      if (hg[k]! > maxH) { maxH = hg[k]!; maxCount = 1; }
      else if (hg[k] === maxH) maxCount++;
      if (lg[k]! < minL) { minL = lg[k]!; minCount = 1; }
      else if (lg[k] === minL) minCount++;
    }
    if (hg[j] === maxH && maxCount === 1) phc[i] = hg[j]!;
    if (lg[j] === minL && minCount === 1) plc[i] = lg[j]!;
  }

  let lastPh: Pivot | null = null;
  let lastPl: Pivot | null = null;
  let brokenPhPi = -1;
  let brokenPlPi = -1;
  let state: "IDLE" | "ARMED" | "CONSUMED" = "IDLE";
  let leg: { side: "LONG" | "SHORT"; E: number; S: number; T: number; Hs: number; Lp: number; highIdx: number; lowIdx: number; bosIdx: number } | null = null;

  for (let i = 0; i < end; i++) {
    if (phc[i] !== null) lastPh = { price: phc[i]!, idx: i - N };
    if (plc[i] !== null) lastPl = { price: plc[i]!, idx: i - N };

    if (state === "IDLE") {
      let bosSide: "LONG" | "SHORT" | null = null;
      if (lastPh && lastPl && lastPl.idx < i && c[i]! > lastPh.price && lastPh.idx !== brokenPhPi) {
        bosSide = "LONG";
      } else if (lastPh && lastPl && lastPl.idx < i && c[i]! < lastPl.price && lastPl.idx !== brokenPlPi) {
        bosSide = "SHORT";
      }
      if (bosSide) {
        if (bosSide === "LONG") {
          const Lp = lastPl!.price;
          let Hs = -Infinity, highIdx = lastPl!.idx;
          for (let k = lastPl!.idx; k <= i; k++) if (hg[k]! > Hs) { Hs = hg[k]!; highIdx = k; }
          if (Hs > Lp) {
            const rng = Hs - Lp;
            const E = Hs - FIB_ENTRY_RATIO * rng;
            if (c[i]! > E) {
              leg = { side: "LONG", E, S: Lp, T: Hs, Hs, Lp, highIdx, lowIdx: lastPl!.idx, bosIdx: i };
              state = "ARMED";
              brokenPhPi = lastPh!.idx;
            }
          }
        } else {
          const Hs = lastPh!.price;
          let Lp = Infinity, lowIdx = lastPh!.idx;
          for (let k = lastPh!.idx; k <= i; k++) if (lg[k]! < Lp) { Lp = lg[k]!; lowIdx = k; }
          if (Hs > Lp) {
            const rng = Hs - Lp;
            const E = Lp + FIB_ENTRY_RATIO * rng;
            if (c[i]! < E) {
              leg = { side: "SHORT", E, S: Hs, T: Lp, Hs, Lp, highIdx: lastPh!.idx, lowIdx, bosIdx: i };
              state = "ARMED";
              brokenPlPi = lastPl!.idx;
            }
          }
        }
      }
    } else if (state === "ARMED" && leg) {
      const { side, E, S, T } = leg;
      // closeBased (14 Okt 2026, lane SWING): sentuhan & invalidasi juga dari
      // CLOSE (konsisten penuh "berdasarkan close candle"): LONG touch =
      // close menembus di bawah E; invalidasi = close di bawah S / di atas T.
      const hitE = options.closeBased
        ? (side === "LONG" ? c[i]! <= E : c[i]! >= E)
        : (l[i]! <= E && E <= h[i]!);
      const inv = options.closeBased
        ? (side === "LONG" ? (c[i]! < S || c[i]! >= T) : (c[i]! > S || c[i]! <= T))
        : (side === "LONG" ? (l[i]! < S || h[i]! >= T) : (h[i]! > S || l[i]! <= T));
      if (inv) {
        // Invalidasi menang atas sentuhan di bar yang sama (bound pesimis/SL-dulu)
        // dan zero-chasing: leg batal, kembali IDLE mencari BOS berikutnya.
        state = "IDLE";
        leg = null;
      } else if (hitE) {
        // Level 0.618 tersentuh: leg TERPAKAI (di live ini momen entry market).
        state = "CONSUMED";
      }
    } else if (state === "CONSUMED" && leg) {
      // Leg sudah terpakai (entry); tunggu penyelesaian (TP atau SL tersentuh),
      // lalu kembali IDLE supaya BOS berikutnya bisa membentuk setup baru.
      const { side, S, T } = leg;
      const resolved = options.closeBased
        ? (side === "LONG" ? (c[i]! >= T || c[i]! <= S) : (c[i]! <= T || c[i]! >= S))
        : (side === "LONG" ? (h[i]! >= T || l[i]! <= S) : (l[i]! <= T || h[i]! >= S));
      if (resolved) {
        state = "IDLE";
        leg = null;
      }
    }
  }

  if (state !== "ARMED" || !leg) return null;
  return {
    side: leg.side,
    entryLevel: leg.E,
    slLevel: leg.S,
    tpLevel: leg.T,
    range: leg.Hs - leg.Lp,
    swingHigh: leg.Hs,
    swingLow: leg.Lp,
    swingHighIdx: leg.highIdx,
    swingLowIdx: leg.lowIdx,
    bosIdx: leg.bosIdx,
    barsSinceBos: end - 1 - leg.bosIdx,
  };
}
