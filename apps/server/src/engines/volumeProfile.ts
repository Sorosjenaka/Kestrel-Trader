// apps/server/src/engines/volumeProfile.ts
// Big Brain Tahap B3 (14 Okt 2026): Volume Profile v1 dari klines (approximasi).
//
// Metode: volume tiap bar didistribusikan UNIFORM ke bin harga di sepanjang
// range bar (low..high). Approximasi tanpa aggTrade — cukup akurat untuk
// POC/Value Area pada klines 1m/5m (plan Big Brain: klines dulu, aggTrade
// upgrade nanti). Modul PURE tanpa I/O — testable offline, sesuai konvensi
// repo. Belum menjadi gate (plan B3: fitur dulu, gate setelah validasi).
//
// Output utama:
//  - POC  : harga bin dengan volume tertinggi (lokasi pasar "sepakat")
//  - VAH/VAL : Value Area 70% volume (bin tertinggi menyebar keluar POC)
//  - HVN/LVN  : puncak/lembah lokal profil (magnet & dinding volume)
import { Bar } from "../universe/eligibility.js";

export const VP_DEFAULT_BINS = 48;
export const VP_VALUE_AREA_PCT = 0.70;

export interface VpBin {
  /** Harga tengah bin. */
  mid: number;
  volume: number;
}

export interface VolumeProfile {
  bins: VpBin[];
  /** Harga POC (mid bin volume tertinggi). null bila data tidak valid. */
  poc: number | null;
  /** Value Area High. */
  vah: number | null;
  /** Value Area Low. */
  val: number | null;
  binSize: number;
  minPrice: number;
  totalVolume: number;
}

/**
 * Bangun volume profile dari klines. Volume bar didistribusikan uniform ke
 * semua bin yang tersentuh range [low, high] bar tersebut (weighted ke bin
 * yang overlap penuh/parsial — metode "uniform over touched bins").
 */
export function buildVolumeProfile(bars: Bar[], binCount = VP_DEFAULT_BINS): VolumeProfile {
  const empty: VolumeProfile = { bins: [], poc: null, vah: null, val: null, binSize: 0, minPrice: 0, totalVolume: 0 };
  if (!Array.isArray(bars) || bars.length === 0 || !Number.isFinite(binCount) || binCount < 2) return empty;

  let minPrice = Infinity;
  let maxPrice = -Infinity;
  let totalVolume = 0;
  for (const b of bars) {
    if (![b.low, b.high, b.volume].every(Number.isFinite)) return empty;
    if (b.low < minPrice) minPrice = b.low;
    if (b.high > maxPrice) maxPrice = b.high;
    totalVolume += b.volume;
  }
  if (minPrice > maxPrice || totalVolume <= 0) return empty;

  const range = maxPrice - minPrice;
  // Range nol (harga beku): semua volume milik satu harga -> binSize 0 dan
  // profil "satu bin". Hindari jalur floor() yang salah kalau fallback 1.
  const binSize = range > 0 ? range / binCount : 0;
  const volumes = new Array<number>(binCount).fill(0);
  if (binSize === 0) {
    return {
      bins: [{ mid: Number(minPrice.toFixed(8)), volume: totalVolume }],
      poc: Number(minPrice.toFixed(8)),
      vah: Number(maxPrice.toFixed(8)),
      val: Number(minPrice.toFixed(8)),
      binSize: 0,
      minPrice: Number(minPrice.toFixed(8)),
      totalVolume,
    };
  }

  for (const b of bars) {
    const lo = b.low === maxPrice ? binCount - 1 : Math.floor((b.low - minPrice) / binSize);
    const hi = b.high === maxPrice ? binCount - 1 : Math.floor((b.high - minPrice) / binSize);
    const touched = hi - lo + 1;
    if (touched <= 0) continue;
    const perBin = b.volume / touched;
    for (let i = lo; i <= hi; i++) volumes[i]! += perBin;
  }

  const bins: VpBin[] = volumes.map((v, i) => ({ mid: minPrice + (i + 0.5) * binSize, volume: v }));

  // POC = bin volume tertinggi (tie -> bin tengah lebih rendah index pertama).
  let pocIdx = 0;
  for (let i = 1; i < binCount; i++) if (volumes[i]! > volumes[pocIdx]!) pocIdx = i;

  // Value Area 70%: mulai dari POC, ekspansi ke sisi dengan bin lebih besar
  // (standar market-profile), sampai kumulatif >= 70% total.
  const target = VP_VALUE_AREA_PCT * totalVolume;
  let lo = pocIdx;
  let hi = pocIdx;
  let cumulative = volumes[pocIdx]!;
  while (cumulative < target && (lo > 0 || hi < binCount - 1)) {
    const below = lo > 0 ? volumes[lo - 1]! : -1;
    const above = hi < binCount - 1 ? volumes[hi + 1]! : -1;
    if (above >= below) {
      hi += 1;
      cumulative += volumes[hi]!;
    } else {
      lo -= 1;
      cumulative += volumes[lo]!;
    }
  }

  return {
    bins,
    poc: Number((minPrice + (pocIdx + 0.5) * binSize).toFixed(8)),
    vah: Number((minPrice + (hi + 1) * binSize).toFixed(8)),
    val: Number((minPrice + lo * binSize).toFixed(8)),
    binSize: Number(binSize.toFixed(8)),
    minPrice: Number(minPrice.toFixed(8)),
    totalVolume,
  };
}

/** Level lokal signifikan dari profil (HVN = magnet, LVN = dinding). */
export interface HvLvnLevels {
  hvn: number[];
  lvn: number[];
}

/**
 * Deteksi HVN/LVN: puncak & lembah LOKAL pada profil (bandingkan dengan
 * tetangga kiri-kanan). `minRatio` menyaring level yang volumenyya kecil
 * relatif terhadap POC (noise filter, default 0.5 untuk HVN).
 */
export function findHvnLvn(profile: VolumeProfile, minRatio = 0.5): HvLvnLevels {
  const hvn: number[] = [];
  const lvn: number[] = [];
  const bins = profile.bins;
  if (bins.length < 3 || profile.poc === null) return { hvn, lvn };
  const maxVol = Math.max(...bins.map((b) => b.volume));
  if (maxVol <= 0) return { hvn, lvn };

  for (let i = 1; i < bins.length - 1; i++) {
    const v = bins[i]!.volume;
    if (v <= 0) continue;
    const isPeak = v >= bins[i - 1]!.volume && v > bins[i + 1]!.volume;
    const isValley = v <= bins[i - 1]!.volume && v < bins[i + 1]!.volume;
    if (isPeak && v >= minRatio * maxVol) hvn.push(Number(bins[i]!.mid.toFixed(8)));
    if (isValley && v > 0) lvn.push(Number(bins[i]!.mid.toFixed(8)));
  }
  return { hvn, lvn };
}

/**
 * Jarak harga terhadap POC dalam satuan bin (positif = di atas POC).
 * Untuk fitur regime: harga jauh di atas VA + POC merambat naik = tren sehat.
 */
export function distanceFromPocInBins(profile: VolumeProfile, price: number): number | null {
  if (profile.poc === null || profile.binSize <= 0 || !Number.isFinite(price)) return null;
  return Number(((price - profile.poc) / profile.binSize).toFixed(2));
}
