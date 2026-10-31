// apps/server/src/strategies/swingBreakoutEngine.ts
// PORT 1:1 dari mesin riset "Breakout Pattern Setup" (WillyAlgoTrader) — file
// referensi: .hermes/cache/scratch/tv-strats/v2_breakout.py + engine.py
// (validasi paritas: apps/server/tests/swingBreakoutEngine.test.ts membandingkan
// sinyal TS vs Python pada 5 simbol, bar 1h Apr-Okt 2026, fixtures/swing/).
//
// Aturan mesin (identik Python, tidak ada parameter baru):
//   - pivot high/low: pivotLen L=5 kiri+kanan; dikenal 5 bar SETELAH pivot
//     (anti-lookahead); daftar pivot maks 60, scan maks 15 pivot terbaru.
//   - channel: 2 garis (upper dari pivot high, lower dari pivot low), >=2
//     touch/sisi, deviasi <= 0.30*ATR20, lebar akhir 0.5..10x ATR20,
//     konvergensi >= 2%, close bar sebelumnya DI DALAM channel.
//   - volume: kontraksi — rasio volume dalam channel vs sebelum channel < 0.85
//     (volSMA20, tanpa data volume -> volOk = true, sama seperti Python).
//   - entry: close bar i menembus garis channel (bar 1h SUDAH TUTUP), fill di
//     close[i] (konvensi riset sim2.py).
//   - SL = garis berlawanan (opposite boundary) — risk engine S-05 mengalikan
//     jarak SL x2 (konvensi riset sim4: sl_mult=2.0).
//   - Ladder exit (keputusan operator 13 Okt 2026): R = 2x jarak SL-garis;
//     TP1 = R*5/3 (tutup 40%), TP2 = R*10/3 (tutup 30%), TPmax = R*5 (sisa
//     30%); setelah TP2 SL pindah ke entry (BE). Setara V10 yang tervalidasi.
//   - Timeout mesin 360 bar HANYA untuk state re-arm internal (identik Python);
//     exit TIMEOUT posisi NONAKTIF di produksi (aturan rumah).
//
// Golden Rules: semua angka dihitung deterministik di sini; LLM tidak pernah
// menghitung nominal. Anti-lookahead: hanya bar yang SUDAH TUTUP yang boleh
// diberikan ke step() — pemanggil (live funnel / backtest) wajib memotong bar
// berjalan sebelum memanggil.
import type { Bar } from "../universe/eligibility.js";

/** Konstanta mesin — WAJIB identik v2_breakout.py (perubahan = butuh paritas baru). */
export const SWING_PIVOT_LEN = 5;
export const SWING_MAX_CH_BARS = 120;
export const SWING_MIN_TOUCH = 2;
export const SWING_CONV_MIN = 0.02;
export const SWING_MAX_PIVOT_SCAN = 15;
export const SWING_MAX_PIVOTS = 60;
export const SWING_RESCAN = 10;
export const SWING_VOL_CONTR_THRESH = 0.85;
export const SWING_TIMEOUT_MULT = 3;
export const SWING_MAX_WIDTH_MULT = 10.0;
/** Pengali jarak SL (konvensi riset sim4.Pos sl_mult=2.0): SL efektif = 2x jarak ke garis. */
export const SWING_SL_MULT = 2.0;
/** TPmax dalam satuan R efektif (V9/V10: TP 5R). */
export const SWING_TP_R = 5.0;
/** Porsi ladder (operator 13 Okt 2026): TP1 40% / TP2 30% / sisa 30% ke TPmax. */
/** @deprecated legacy ladder only; RR23 uses 0.5/0.5 in researchExitPolicy. */
export const SWING_TP1_FRAC = 0.4;
/** @deprecated legacy ladder only; RR23 uses 0.5/0.5 in researchExitPolicy. */
export const SWING_TP2_FRAC = 0.3;
/** Warmup mesin = max(2L+MAX_CH_BARS, 50) — identik Python. */
export const SWING_WARMUP = Math.max(2 * SWING_PIVOT_LEN + SWING_MAX_CH_BARS, 50);

export interface SwingSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface SwingSignal {
  /** Index bar sinyal pada seri yang diberikan (bar 1h SUDAH TUTUP). */
  index: number;
  /** openTime bar sinyal (ms). */
  time: number;
  side: "LONG" | "SHORT";
  /** Harga entry = close bar sinyal (konvensi riset). */
  entry: number;
  /** Nilai garis berlawanan pada bar sinyal (anchor SL struktural). */
  opposite: number;
  /** SL efektif = entry -/+ R (R = SWING_SL_MULT x jarak entry->opposite). */
  sl: number;
  /** Ladder: TP1 (40%) / TP2 (30%, lalu SL->entry) / TPmax (sisa 30%). */
  tp1: number;
  tp2: number;
  tpMax: number;
  /** R efektif (jarak entry -> SL efektif). */
  rDistance: number;
  /** R / entry (untuk band SL gate). */
  slPct: number;
  upper: SwingSegment;
  lower: SwingSegment;
  /** Lebar channel di bar sinyal (x ATR20 untuk audit). */
  channelWidth: number;
  conv: number;
}

/** ATR RMA (Wilder) periode n — identik engine.py: tr[0]=h-l, RMA run avg. */
export function swingAtr(h: number[], l: number[], c: number[], n: number): number[] {
  const len = c.length;
  const tr = new Array<number>(len).fill(NaN);
  for (let i = 0; i < len; i++) {
    if (i === 0) {
      tr[i] = h[0]! - l[0]!;
      continue;
    }
    tr[i] = Math.max(
      h[i]! - l[i]!,
      Math.abs(h[i]! - c[i - 1]!),
      Math.abs(l[i]! - c[i - 1]!)
    );
  }
  return rmaSeries(tr, n);
}

/** ta.rma — identik engine.py (seed = rata-rata n nilai pertama). */
export function rmaSeries(x: number[], n: number): number[] {
  const out = new Array<number>(x.length).fill(NaN);
  let run: number | null = null;
  const vals: number[] = [];
  for (let i = 0; i < x.length; i++) {
    const v = x[i]!;
    if (Number.isNaN(v)) {
      out[i] = run === null ? NaN : run;
      continue;
    }
    if (run === null) {
      vals.push(v);
      if (vals.length === n) {
        run = vals.reduce((a, b) => a + b, 0) / n;
        out[i] = run;
      }
    } else {
      run = (run * (n - 1) + v) / n;
      out[i] = run;
    }
  }
  return out;
}

/** ta.sma — identik engine.py (NaN-aware, butuh jendela penuh non-NaN). */
export function smaSeries(x: number[], n: number): number[] {
  const len = x.length;
  const out = new Array<number>(len).fill(NaN);
  const z = new Array<number>(len);
  const k = new Array<number>(len);
  for (let i = 0; i < len; i++) {
    z[i] = Number.isNaN(x[i]) ? 0 : x[i]!;
    k[i] = Number.isNaN(x[i]) ? 0 : 1;
  }
  const cz: number[] = new Array(len).fill(0);
  const ck: number[] = new Array(len).fill(0);
  for (let i = 0; i < len; i++) {
    cz[i] = (i ? cz[i - 1]! : 0) + z[i]!;
    ck[i] = (i ? ck[i - 1]! : 0) + k[i]!;
  }
  for (let i = n - 1; i < len; i++) {
    const prev = i - n;
    const s = cz[i]! - (prev >= 0 ? cz[prev]! : 0);
    const kn = ck[i]! - (prev >= 0 ? ck[prev]! : 0);
    out[i] = kn === n ? s / n : NaN;
  }
  return out;
}

/** cumsum volume (identik np.cumsum di mesin). */
function cumsum(x: number[]): number[] {
  const out = new Array<number>(x.length).fill(0);
  for (let i = 0; i < x.length; i++) out[i] = (i ? out[i - 1]! : 0) + x[i]!;
  return out;
}

function lineAt(seg: SwingSegment, x: number): number {
  const { x1, y1, x2, y2 } = seg;
  if (Math.abs(x2 - x1) <= 1e-10) return y1;
  return y1 + ((y2 - y1) * (x - x1)) / (x2 - x1);
}

interface PivotPoint {
  price: number;
  bar: number; // index bar pivot asli (sudah dikurangi L, identik Python i - L)
}

/**
 * Mesin breakout — stateful, dipanggil per bar berurutan (bar 1h SUDAH TUTUP).
 * Semafora state identik v2_breakout.Machine; posisi dikelola pemanggil:
 * - `openTrade()` dipanggil saat sinyal dieksekusi jadi posisi (mengunci
 *   re-arm, identik tradePos Python).
 * - `clearTrade()` saat posisi tertutup (atau dipanggil tiap bar oleh harness
 *   paritas yang menerima semua sinyal — mode FakePF).
 */
export interface SwingBreakoutOptions {
  /** Optional candidate-only volume contraction threshold; undefined = frozen 0.85. */
  volContrThresh?: number;
  /** Optional candidate-only structural SL multiplier; undefined = frozen 2.0. */
  slMult?: number;
}

export class SwingBreakoutMachine {
  private opts: SwingBreakoutOptions;
  private o: number[];
  private h: number[];
  private l: number[];
  private c: number[];
  private v: number[];
  private n: number;
  private atr20: number[];
  private volSma: number[];
  private cumv: number[];
  private hasVol: boolean;
  private hiP: PivotPoint[] = [];
  private loP: PivotPoint[] = [];
  private active = false;
  private up: SwingSegment | null = null;
  private low: SwingSegment | null = null;
  private maxw = 0;
  private channelW = 0;
  private conv = 0;
  private detect = -1e9;
  private tradeOpen = false;
  private brk = -1e9;
  private times: number[];

  constructor(bars: Bar[], opts: SwingBreakoutOptions = {}) {
    this.opts = opts;
    this.o = bars.map((b) => b.open);
    this.h = bars.map((b) => b.high);
    this.l = bars.map((b) => b.low);
    this.c = bars.map((b) => b.close);
    this.v = bars.map((b) => b.volume);
    this.times = bars.map((b) => b.openTime);
    this.n = bars.length;
    this.atr20 = swingAtr(this.h, this.l, this.c, 20);
    this.volSma = smaSeries(this.v, 20);
    this.cumv = cumsum(this.v);
    this.hasVol = this.v.reduce((a, b) => a + b, 0) > 0;
  }

  openTrade(): void {
    this.tradeOpen = true;
  }

  /**
   * Posisi tertutup — identik semantik eviksi Python (tradePos tidak ada lagi
   * di pf.positions): tradePos=None, active=False, bdir=0. Channel aktif
   * dilupakan dan di-deteksi ulang lewat scan, sama seperti mesin riset.
   */
  clearTrade(): void {
    this.tradeOpen = false;
    this.active = false;
  }

  get tradeIsOpen(): boolean {
    return this.tradeOpen;
  }

  /** Nilai pivot high/low yang di-emit pada bar i (pivot bar = i - L). */
  private pivotEmission(i: number): { ph: number; pl: number } {
    let ph = NaN;
    let pl = NaN;
    const L = SWING_PIVOT_LEN;
    const pi = i - L;
    if (pi >= L && pi < this.n - L) {
      const winH = this.h.slice(pi - L, pi + L + 1);
      const winL = this.l.slice(pi - L, pi + L + 1);
      if (!winH.some((x) => Number.isNaN(x))) {
        const mx = Math.max(...winH);
        if (this.h[pi] === mx && winH.filter((x) => x === mx).length === 1) ph = this.h[pi]!;
      }
      if (!winL.some((x) => Number.isNaN(x))) {
        const mn = Math.min(...winL);
        if (this.l[pi] === mn && winL.filter((x) => x === mn).length === 1) pl = this.l[pi]!;
      }
    }
    return { ph, pl };
  }

  /** Fit garis terbaik (maks touch) — identik _fit() Python. */
  private fit(pts: PivotPoint[], sign: number, devTol: number, touchTol: number):
    { seg: SwingSegment; touches: number } | null {
    const m = pts.length;
    if (m < 2) return null;
    let best: SwingSegment | null = null;
    let bestn = -1;
    for (let a = 0; a < m; a++) {
      for (let b = a + 1; b < m; b++) {
        const ax = pts[a]!.bar;
        const ay = pts[a]!.price;
        const bx = pts[b]!.bar;
        const by = pts[b]!.price;
        if (Math.abs(bx - ax) < 1.0) continue;
        let ok = true;
        const dd = new Array<number>(m).fill(0);
        for (let i = 0; i < m; i++) {
          const lx = ay + ((by - ay) * (pts[i]!.bar - ax)) / (bx - ax);
          dd[i] = sign * (pts[i]!.price - lx);
          if (dd[i]! > devTol) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        let ntouch = 0;
        for (let i = 0; i < m; i++) if (Math.abs(dd[i]!) <= touchTol) ntouch++;
        if (ntouch > bestn) {
          bestn = ntouch;
          best = { x1: ax, y1: ay, x2: bx, y2: by };
        }
      }
    }
    return best ? { seg: best, touches: bestn } : null;
  }

  /**
   * Satu bar. `i` = index bar pada seri (0-based). Kembalikan sinyal bila bar
   * ini menembus channel (belum ada posisi terbuka di mesin). Identik step() Python.
   */
  step(i: number): SwingSignal | null {
    if (i < 0 || i >= this.n) return null;
    const c = this.c;
    // timeout posisi internal (hanya state re-arm; BUKAN exit produksi)
    if (this.tradeOpen && i - this.brk > SWING_MAX_CH_BARS * SWING_TIMEOUT_MULT) {
      this.tradeOpen = false;
      this.active = false;
    }
    const { ph, pl } = this.pivotEmission(i);
    if (!Number.isNaN(ph)) {
      this.hiP.unshift({ price: ph, bar: i - SWING_PIVOT_LEN });
      if (this.hiP.length > SWING_MAX_PIVOTS) this.hiP.pop();
    }
    if (!Number.isNaN(pl)) {
      this.loP.unshift({ price: pl, bar: i - SWING_PIVOT_LEN });
      if (this.loP.length > SWING_MAX_PIVOTS) this.loP.pop();
    }
    if (this.active && i - this.detect > SWING_MAX_CH_BARS) {
      this.active = false;
    }
    const newpiv = !Number.isNaN(ph) || !Number.isNaN(pl);
    let result: SwingSignal | null = null;
    if (
      (newpiv || i % SWING_RESCAN === 0) &&
      !this.active &&
      !this.tradeOpen &&
      i >= SWING_WARMUP &&
      this.hiP.length >= SWING_MIN_TOUCH &&
      this.loP.length >= SWING_MIN_TOUCH &&
      !Number.isNaN(this.atr20[i]!) &&
      this.atr20[i]! > 0
    ) {
      const h = this.h;
      const l = this.l;
      const o = this.o;
      const devTol = this.atr20[i]! * 0.3;
      const touchTol = this.atr20[i]! * 0.15;
      const upc = this.hiP.filter((p) => i - p.bar <= SWING_MAX_CH_BARS).slice(0, SWING_MAX_PIVOT_SCAN + 1);
      const loc = this.loP.filter((p) => i - p.bar <= SWING_MAX_CH_BARS).slice(0, SWING_MAX_PIVOT_SCAN + 1);
      const u = this.fit(upc, 1, devTol, touchTol);
      const d = this.fit(loc, -1, devTol, touchTol);
      if (u && d && u.touches >= SWING_MIN_TOUCH && d.touches >= SWING_MIN_TOUCH) {
        const useg = u.seg;
        const lseg = d.seg;
        const xs = [useg.x1, useg.x2, lseg.x1, lseg.x2];
        const startX = Math.min(...xs);
        const endX = i;
        const w0 = lineAt(useg, startX) - lineAt(lseg, startX);
        const w1 = lineAt(useg, endX) - lineAt(lseg, endX);
        const conv = w0 > 0 ? 1 - w1 / w0 : 0.0;
        const widthOk = w1 >= this.atr20[i]! * 0.5 && w1 < this.atr20[i]! * SWING_MAX_WIDTH_MULT;
        const inside = lineAt(lseg, endX) <= c[i - 1]! && c[i - 1]! <= lineAt(useg, endX);
        const ovS = Math.max(useg.x1, lseg.x1);
        const ovE = Math.min(useg.x2, lseg.x2);
        let maxH: number;
        if (ovE > ovS) {
          const k = Math.max(Math.floor((ovE - ovS) / 5), 2);
          maxH = -Infinity;
          for (let t = 0; t <= k; t++) {
            const x = ovS + (t * (ovE - ovS)) / k;
            maxH = Math.max(maxH, lineAt(useg, x) - lineAt(lseg, x));
          }
        } else {
          const mid = (Math.max(...xs) + Math.min(...xs)) / 2;
          maxH = lineAt(useg, mid) - lineAt(lseg, mid);
        }
        const pb = Math.floor(startX);
        const sb = Math.min(Math.max(i - pb, 1), i);
        const pre = Math.min(sb, pb);
        let volOk = true;
        if (this.hasVol && sb > 0 && i - sb >= 0 && i - sb - pre >= 0) {
          // 16 Okt 2026 (fix volOk no-op — persetujuan operator): rasio volume
          // dalam channel vs sebelum channel, KEDUANYA rata-rata volume per bar
          // (sebanding, sesuai dokumentasi baris 13). Sebelumnya vin dibagi
          // volSMA20 tapi vpre tidak -> ratio ~0 terus -> volOk selalu true dan
          // gate kontraksi volume tidak pernah bekerja. Konsekuensi jujur:
          // sinyal S-05 berkurang (channel tanpa kontraksi volume tidak lagi
          // menghasilkan entry). Paritas TS<->Python dijaga lewat dump yang
          // diregenerasi (fixtures/swing/signals_parity.json).
          const vin = (this.cumv[i]! - this.cumv[i - sb]!) / sb;
          const vpre = (this.cumv[i - sb]! - this.cumv[i - sb - pre]!) / (pre > 0 ? pre : 1);
          const ratio = vpre > 0 ? vin / vpre : 1.0;
          volOk = ratio < (this.opts.volContrThresh ?? SWING_VOL_CONTR_THRESH);
        }
        if (w1 > 0 && conv >= SWING_CONV_MIN && widthOk && inside && volOk) {
          this.active = true;
          this.up = useg;
          this.low = lseg;
          this.maxw = maxH;
          this.channelW = w1;
          this.conv = conv;
          this.detect = i;
        }
      }
    }
    if (this.active && !this.tradeOpen && i >= SWING_WARMUP && i > this.detect && this.up && this.low) {
      const up = lineAt(this.up, i);
      const lo = lineAt(this.low, i);
      if (c[i]! > up || c[i]! < lo) {
        const bull = c[i]! > up;
        const dirn = bull ? 1 : -1;
        const boundary = bull ? up : lo;
        const opp = bull ? lo : up;
        const entry = c[i]!;
        const tgt = boundary + dirn * this.maxw;
        const full = Math.abs(tgt - entry);
        if (full > 0 && entry !== opp) {
          const r = (this.opts.slMult ?? SWING_SL_MULT) * Math.abs(entry - opp);
          const sl = entry - dirn * r;
          result = {
            index: i,
            time: this.times[i]!,
            side: bull ? "LONG" : "SHORT",
            entry,
            opposite: opp,
            sl,
            tp1: entry + dirn * r * (SWING_TP_R / 3.0),
            tp2: entry + dirn * r * ((SWING_TP_R * 2.0) / 3.0),
            tpMax: entry + dirn * r * SWING_TP_R,
            rDistance: r,
            slPct: entry > 0 ? r / entry : 0,
            upper: this.up,
            lower: this.low,
            channelWidth: this.channelW,
            conv: this.conv,
          };
          // identik Python: posisi terbuka -> tradePos terkunci (re-arm berhenti)
          this.tradeOpen = true;
          this.brk = i;
        }
      }
    }
    return result;
  }
}

/**
 * Jalankan mesin pada satu seri bar (semua bar dianggap SUDAH TUTUP —
 * pemanggil wajib memotong bar berjalan). Mode harness: setiap sinyal
 * langsung di-clear (identik FakePF dump_signals.py) -> sinyal level mesin.
 */
export function runSwingBreakoutSignals(bars: Bar[], harnessAll = true, opts: SwingBreakoutOptions = {}): SwingSignal[] {
  const m = new SwingBreakoutMachine(bars, opts);
  const out: SwingSignal[] = [];
  for (let i = 0; i < bars.length; i++) {
    const sig = m.step(i);
    if (sig) {
      out.push(sig);
      if (harnessAll) m.clearTrade();
    }
  }
  return out;
}

/** Sinyal pada bar terakhir saja (live funnel: bar 1h terakhir yang baru tutup). */
export function latestSwingBreakoutSignal(bars: Bar[], opts: SwingBreakoutOptions = {}): SwingSignal | null {
  const m = new SwingBreakoutMachine(bars, opts);
  let last: SwingSignal | null = null;
  for (let i = 0; i < bars.length; i++) {
    const sig = m.step(i);
    if (sig) {
      last = sig;
      m.clearTrade();
    }
  }
  return last && last.index === bars.length - 1 ? last : null;
}
