import { expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import webCatalog from "../../web/src/data/swingResearch.json" with { type: "json" };
import { STRATEGY_CATALOG } from "../src/backtest/backtestEngine.js";
it("registers the approved research candidates consistently without making them live-executable",async()=>{
  const r = await request(createApp()).get("/api/research/swing-strategies").set("x-api-token", "vitest-mutation-token");
  expect(r.status).toBe(200);
  expect(r.body).toEqual(webCatalog);
  expect(r.body.strategies).toHaveLength(3);
  for(const s of r.body.strategies){ expect(s.liveEnabled).toBe(false); }
  // T0.5 (18 Okt 2026): RSW-01/02/03 sekarang ada di STRATEGY_CATALOG
  // (sudah di-port ke engines/ TS), tapi tetap PAPER-only via allowlist.
  expect(STRATEGY_CATALOG["RSW-01"]).toBeDefined();
  expect(STRATEGY_CATALOG["RSW-01"]!.requiresOperatorApproval).toBe(true);
  expect(STRATEGY_CATALOG["RSW-02"]).toBeDefined();
  expect(STRATEGY_CATALOG["RSW-03"]).toBeDefined();
  expect(r.body.strategies[2].stress).toBeNull();
});

it("reports an offline isolated worker without starting a bot or contacting an exchange",async()=>{
  const spy=vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("worker offline"));
  try {
    const r=await request(createApp()).get("/api/research/swing-paper/status").set("x-api-token", "vitest-mutation-token");
    expect(r.status).toBe(503);expect(r.body.liveEnabled).toBe(false);
    expect(spy.mock.calls[0]?.[0]).toBe("http://127.0.0.1:8791/status");
  }finally{spy.mockRestore();}
});
