// apps/server/src/backtest/validation/slippageModel.ts
// Dynamic Slippage Model based on Volatility and Order Size impact.

export interface SlippageContext {
  baseSlippageBps: number;       // Exchange baseline spread cost
  atrCurrent: number;            // Current Average True Range
  atrAverage24h: number;         // Rolling average ATR
  orderNotionalUsd: number;      // Size of the trade
  barVolumeUsd: number;          // Volume traded in the current candle
}

/**
 * Calculates effective slippage in Basis Points (bps).
 * Formula: Effective = Base * (1 + Alpha * ParticipationRatio) * VolatilityMultiplier
 * 
 * @param ctx Market conditions
 * @param alpha Impact coefficient (typically 0.1 - 0.5 for liquid pairs, higher for alts)
 * @returns Slippage in bps
 */
export function calculateDynamicSlippage(ctx: SlippageContext, alpha: number = 0.2): number {
  // 1. Volatility Multiplier
  // If current ATR is 2x average, slippage doubles (roughly).
  const volFactor = ctx.atrAverage24h > 0 ? Math.max(1.0, ctx.atrCurrent / ctx.atrAverage24h) : 1.0;
  
  // 2. Participation Ratio (Order Size Impact)
  // How much of the bar's volume does this order represent?
  // Cap at 1.0 to avoid infinite slippage simulation errors.
  const participation = ctx.barVolumeUsd > 0 
    ? Math.min(1.0, ctx.orderNotionalUsd / ctx.barVolumeUsd) 
    : 0.1; // Default assumption if volume data missing
  
  // Square root law often applies to market impact, but linear approx is safer for conservative backtesting
  const impactFactor = 1 + (alpha * participation);
  
  // 3. Final Calculation
  const effectiveBps = ctx.baseSlippageBps * volFactor * impactFactor;
  
  return Math.round(effectiveBps * 100) / 100; // Round to 2 decimals
}

export interface StressScenario {
  name: string;
  volatilityMultiplier: number; // Extra factor on top of natural vol
  liquidityHaircutPercent: number; // Reduce available volume by X%
  latencyMs: number; // Delay execution by X ms (simulated via price drift in next bar)
}

export const STRESS_PRESETS: Record<string, StressScenario> = {
  NORMAL: {
    name: "Normal Conditions",
    volatilityMultiplier: 1.0,
    liquidityHaircutPercent: 0,
    latencyMs: 0
  },
  FLASH_CRASH: {
    name: "Flash Crash / Panic Sell",
    volatilityMultiplier: 5.0,
    liquidityHaircutPercent: 80, // Only 20% of usual depth available
    latencyMs: 500
  },
  LOW_LIQUIDITY_WEEKEND: {
    name: "Weekend Thin Markets",
    volatilityMultiplier: 1.5,
    liquidityHaircutPercent: 50,
    latencyMs: 200
  },
  NEWS_SPIKE: {
    name: "Macro News Release",
    volatilityMultiplier: 3.0,
    liquidityHaircutPercent: 30,
    latencyMs: 100
  }
};