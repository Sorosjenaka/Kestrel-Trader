import { describe, expect, it } from "vitest";
import { SWING_RR23_POLICY, usesSwingRr23, withSwingRr23Attrs } from "../src/strategies/swing/researchExitPolicy.js";
import { rrPolicyForMode } from "../src/config/setupEngine.js";
import { swingLadderLevelsFromTp1 } from "../src/strategies/swing/swingLevels.js";
import { simulateLadderExit } from "../src/backtest/historicalReplay.js";
import { swingLadderLevels } from "../src/exec/positionSupervisor.js";

describe("operator SWING 2R/BE/3R policy", () => {
  it("is pinned for versioned SWING PAPER/LIVE and never switches unversioned legacy", () => {
    const entryAttrs = withSwingRr23Attrs('{"setup":"BOS"}');
    expect(JSON.parse(entryAttrs)).toEqual({ setup: "BOS", swingExitPolicy: SWING_RR23_POLICY });
    expect(usesSwingRr23({ mode: "SWING", source: "PAPER_AI", entryAttrs })).toBe(true);
    expect(usesSwingRr23({ mode: "SWING", source: "LIVE_AI", entryAttrs })).toBe(true);
    expect(usesSwingRr23({ mode: "SWING", source: "LIVE_AI" })).toBe(false);
    expect(usesSwingRr23({ mode: "SCALP", source: "PAPER_AI", entryAttrs })).toBe(false);
    expect(usesSwingRr23({ mode: "SWING", source: "PAPER_AI" })).toBe(false);
    expect(rrPolicyForMode("SWING", "S-03", 9).tp1R).toBe(2);
    expect(rrPolicyForMode("SCALP", "S-03").tp1R).toBe(1.7);
  });
  for (const side of ["LONG", "SHORT"] as const) {
    const sign = side === "LONG" ? 1 : -1;
    it(`${side}: two final targets, BE after full TP1 and active on next candle`, () => {
      const tp1 = 100 + sign * 2, final = 100 + sign * 3;
      expect(swingLadderLevelsFromTp1(side, 100, tp1, true)).toEqual({ tp2: final, tpMax: final });
      const pos = { mode: "SWING", source: "PAPER_AI", entryAttrs: withSwingRr23Attrs(), side,
        entryPrice: 100, tp1Price: tp1, tp2Price: final };
      expect(swingLadderLevels(pos)).toEqual({ tp2: final, tpMax: final });
      const bars = side === "LONG"
        ? [[100,102,99.5,101],[101,101.5,100,100.5]]
        : [[100,100.5,98,99],[99,100,98.5,99.5]];
      const result = simulateLadderExit(bars.map(([open,high,low,close],i) => ({ openTime:i*60000,open,high,low,close,volume:1 })),0,
        { side,entry:100,sl:100-sign,tp1,tp2:final,tpMax:final,tp1Frac:.5,tp2Frac:.5,beAfterTp1:true,
          slippageBps:0,outOfSampleTo:120000,intervalMs:60000 });
      expect(result.legs.map(l=>[l.kind,l.frac,l.price])).toEqual([["TP1",.5,tp1],["BE",.5,100]]);
    });
  }
});
