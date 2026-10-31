// AI ANALYSIS (checklist 2026-10-03 T-17): kalibrasi probabilitas agen.
// Menjawab label jujur `SUBJECTIVE_NOT_CALIBRATED` di decisionRiskLayer:
// probabilitas yang dikeluarkan agen dievaluasi terhadap hasil nyata.
export interface PredictionOutcome {
  p: number;
  outcome: 0 | 1;
}

function clip01(p: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(p) ? p : 0));
}

/** Brier score = rata-rata (p - outcome)^2; makin kecil makin baik. */
export function brierScore(preds: PredictionOutcome[]): number {
  if (!preds.length) return 0;
  const sum = preds.reduce((a, x) => {
    const d = clip01(x.p) - x.outcome;
    return a + d * d;
  }, 0);
  return Number((sum / preds.length).toFixed(6));
}

/**
 * Expected Calibration Error: selisih rata-rata |confidence - accuracy|
 * per bin probabilitas (lebar 0.1), dibobot proporsi sampel.
 */
export function expectedCalibrationError(preds: PredictionOutcome[], bins = 10): number {
  if (!preds.length) return 0;
  const buckets: PredictionOutcome[][] = Array.from({ length: bins }, () => []);
  for (const x of preds) {
    const idx = Math.min(bins - 1, Math.floor(clip01(x.p) * bins));
    buckets[idx]!.push(x);
  }
  let ece = 0;
  for (const b of buckets) {
    if (!b.length) continue;
    const conf = b.reduce((a, x) => a + clip01(x.p), 0) / b.length;
    const acc = b.reduce((a, x) => a + x.outcome, 0) / b.length;
    ece += (b.length / preds.length) * Math.abs(conf - acc);
  }
  return Number(ece.toFixed(6));
}
