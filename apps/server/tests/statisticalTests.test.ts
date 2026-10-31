import { describe, expect, it } from "vitest";
import { blockBootstrapEv } from "../src/analytics/stats/blockBootstrap";

describe("blockBootstrapEv", () => {
  const pnls = [1.5, -1, 1.6, -1, 1.4, -1, 1.6, -1, 1.5, -1, 1.6, -0.9];

  it("mengembalikan mean, ciLower, ciUpper", () => {
    const r = blockBootstrapEv(pnls, { blockSize: 3, iterations: 500, seed: 7 });
    expect(r).not.toBeNull();
    expect(r!.ciLower).toBeLessThanOrEqual(r!.mean);
    expect(r!.ciUpper).toBeGreaterThanOrEqual(r!.mean);
  });

  it("deterministik untuk seed yang sama", () => {
    const a = blockBootstrapEv(pnls, { blockSize: 3, iterations: 300, seed: 42 });
    const b = blockBootstrapEv(pnls, { blockSize: 3, iterations: 300, seed: 42 });
    expect(a).toEqual(b);
  });

  it("seed berbeda boleh memberi interval berbeda", () => {
    const a = blockBootstrapEv(pnls, { blockSize: 2, iterations: 200, seed: 1 });
    const b = blockBootstrapEv(pnls, { blockSize: 5, iterations: 200, seed: 2 });
    expect(a!.blockSize).toBe(2);
    expect(b!.blockSize).toBe(5);
  });

  it("sampel terlalu sedikit -> null", () => {
    expect(blockBootstrapEv([1])).toBeNull();
  });
});
