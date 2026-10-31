// apps/server/src/analytics/stats/statisticalTests.ts
// Implementasi manual uji statistik inferensial untuk validasi trading.
// Fokus: Signifikansi Win Rate vs Break-Even, dan Deflated Sharpe Ratio.

/**
 * Approximation of the standard normal CDF (Phi(x)).
 * Uses Abramowitz and Stegun approximation 7.1.26 (max error ~1.5e-7).
 */
function normCdf(x: number): number {
  if (x < -8.0) return 0.0;
  if (x > 8.0) return 1.0;
  
  let sum = 0.0;
  let term = x;
  for (let i = 3; term !== 0 && i <= 200; i += 2) {
    sum += term;
    term *= (x * x) / i;
  }
  const result = 0.5 + Math.exp(-0.5 * x * x) * sum / Math.sqrt(2 * Math.PI);
  return result;
}

/**
 * Inverse Standard Normal CDF (Quantile Function).
 * Used for calculating critical values (Z-score thresholds).
 * Rational approximation by Peter Acklam.
 */
function invNormCdf(p: number): number {
  if (p <= 0 || p >= 1) throw new Error("invNormCdf: p must be in (0, 1)");
  
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q, r;

  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  } else if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
}

export interface ZTestResult {
  zScore: number;
  pValue: number;
  significant: boolean;
  observedWinRate: number;
  expectedWinRate: number; // Break-even rate
  sampleSize: number;
}

/**
 * One-sample Z-test for proportions.
 * Tests if Observed Win Rate is significantly greater than Expected (Break-Even) Win Rate.
 * H0: p_obs <= p_be
 * H1: p_obs > p_be
 */
export function oneSampleZTestProportion(wins: number, trials: number, breakEvenWinRate: number, alpha: number = 0.05): ZTestResult | null {
  if (trials <= 0 || wins < 0 || wins > trials) return null;
  if (breakEvenWinRate <= 0 || breakEvenWinRate >= 1) return null;

  const pObs = wins / trials;
  const pExp = breakEvenWinRate;
  
  // Standard Error under Null Hypothesis
  const se = Math.sqrt((pExp * (1 - pExp)) / trials);
  if (se === 0) return null;

  const z = (pObs - pExp) / se;
  
  // P-value for one-tailed test (right tail)
  const pValue = 1 - normCdf(z);
  const criticalZ = invNormCdf(1 - alpha);
  
  return {
    zScore: z,
    pValue,
    significant: z > criticalZ && pValue < alpha,
    observedWinRate: pObs,
    expectedWinRate: pExp,
    sampleSize: trials
  };
}

export interface DeflatedSharpeResult {
  rawSharpe: number;
  deflatedSharpe: number;
  adjustedPValue: number;
  isRobust: boolean;
  numTrials: number;
}

/**
 * Calculates Deflated Sharpe Ratio (DSR) based on Bailey & Lopez de Prado (2014).
 * Adjusts for multiple testing bias (number of strategies tested) and non-normal returns (skew/kurtosis).
 * 
 * @param meanReturn Annualized mean return
 * @param stdDev Annualized standard deviation
 * @param skewness Skewness of daily returns
 * @param kurtosis Kurtosis of daily returns
 * @param trackLength Number of periods (days)
 * @param numTrials Total number of strategies/parameters tested (to correct selection bias)
 * @param riskFreeRate Risk-free rate (annualized, usually 0 for crypto scalping simplicity or benchmark)
 */
export function calculateDeflatedSharpeRatio(
  meanReturn: number,
  stdDev: number,
  skewness: number,
  kurtosis: number,
  trackLength: number,
  numTrials: number,
  riskFreeRate: number = 0
): DeflatedSharpeResult | null {
  if (stdDev <= 0 || trackLength <= 0 || numTrials <= 0) return null;

  // 1. Raw Sharpe Ratio
  const srRaw = (meanReturn - riskFreeRate) / stdDev;

  // 2. Variance of Sharpe Ratio estimator
  // Var(SR) ≈ (1 + 0.5*SR^2 - Skew*SR + ((Kurt-3)/4)*SR^2) / T
  const varSr = (1 + 0.5 * srRaw * srRaw - skewness * srRaw + ((kurtosis - 3) / 4) * srRaw * srRaw) / trackLength;
  const stdErrSr = Math.sqrt(varSr);

  if (stdErrSr <= 0) return null;

  // 3. Expected Maximum Sharpe Ratio due to Multiple Testing (E[max_SR])
  // Approximation using Euler-Mascheroni constant gamma
  const gamma = 0.5772156649;
  // E[max_SR] ≈ sqrt(VAR_SR) * ((1-gamma)*InvNormCDF(1 - 1/N) + gamma*InvNormCDF(1 - 1/(N*e)))
  // Simplified robust approximation often used:
  const eMaxSr = stdErrSr * ((1 - gamma) * invNormCdf(1 - 1 / numTrials) + gamma * invNormCdf(1 - 1 / (numTrials * Math.E)));

  // 4. Deflated Sharpe Ratio Statistic (Z-score against E[max_SR])
  const dsrZ = (srRaw - eMaxSr) / stdErrSr;
  
  // 5. P-value associated with DSR
  const adjustedPValue = 1 - normCdf(dsrZ);

  return {
    rawSharpe: srRaw,
    deflatedSharpe: dsrZ, // Often reported as the Z-score itself or transformed back
    adjustedPValue,
    isRobust: adjustedPValue < 0.05, // Significant even after penalizing for trying many things
    numTrials
  };
}