// T-12 (checklist 2026-10-03): block-bootstrap EV + momen untuk DSR (T-10).
// Interval keyakinan EV, bukan angka tunggal. Deterministik untuk seed yang sama
// (LCG internal) supaya audit bisa direproduksi. Murni TS, tanpa LLM.
import { calculateDeflatedSharpeRatio, type DeflatedSharpeResult } from "./statisticalTests.js";

export interface BlockBootstrapResult {
  mean: number;
  ciLower: number;
  ciUpper: number;
  iterations: number;
  blockSize: number;
}

function lcg(seed: number): () => number {
  let s = (Math.floor(seed) % 2147483647 + 2147483647) % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function meanOf(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function blockBootstrapEv(
  pnls: number[],
  opts: { blockSize?: number; iterations?: number; seed?: number } = {},
): BlockBootstrapResult | null {
  if (!Array.isArray(pnls) || pnls.length < 2) return null;
  const blockSize = Math.max(1, Math.min(opts.blockSize ?? 5, pnls.length));
  const iterations = Math.max(1, opts.iterations ?? 1000);
  const rnd = lcg(opts.seed ?? 20261003);
  const means: number[] = [];
  const blocksNeeded = Math.ceil(pnls.length / blockSize);
  for (let it = 0; it < iterations; it++) {
    const sample: number[] = [];
    for (let b = 0; b < blocksNeeded; b++) {
      const start = Math.floor(rnd() * (pnls.length - blockSize + 1));
      for (let k = 0; k < blockSize && sample.length < pnls.length; k++) {
        sample.push(pnls[start + k]);
      }
    }
    means.push(meanOf(sample));
  }
  means.sort((a, b) => a - b);
  return {
    mean: meanOf(pnls),
    ciLower: quantile(means, 0.025),
    ciUpper: quantile(means, 0.975),
    iterations,
    blockSize,
  };
}

/**
 * Deflated Sharpe dari deret PnL per trade. numTrials default 1 = koreksi
 * non-normalitas saja; kalau jumlah kandidat yang diuji diketahui, teruskan.
 */
export function deflatedSharpeOf(pnls: number[], numTrials = 1): DeflatedSharpeResult | null {
  const n = pnls.length;
  if (n < 3) return null;
  const mean = meanOf(pnls);
  const variance = pnls.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1);
  const stdDev = Math.sqrt(variance);
  if (stdDev <= 0) return null;
  const skewness = pnls.reduce((a, x) => a + ((x - mean) / stdDev) ** 3, 0) / n;
  const kurtosis = pnls.reduce((a, x) => a + ((x - mean) / stdDev) ** 4, 0) / n;
  // DSR bersifat indikatif: bila turunan statistiknya melempar (mis. p di luar
  // (0,1) pada deret ekstrem), kembalikan null — JANGAN biarkan gate ikut crash.
  try {
    return calculateDeflatedSharpeRatio(mean, stdDev, skewness, kurtosis, n, Math.max(1, numTrials));
  } catch {
    return null;
  }
}
