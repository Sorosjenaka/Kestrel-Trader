import { expect, it } from "vitest";
import { parsePublicLiquidation } from "./publicLiquidations.js";
it("uses executed volume and rejects another symbol or malformed event",()=>{
  const raw = JSON.stringify({e:"forceOrder",E:123,o:{s:"BTCUSDT",S:"SELL",p:"101",ap:"100",q:"9",z:"2",T:123}});
  expect(parsePublicLiquidation(raw,"BTCUSDT")).toMatchObject({price:100,qty:2,notionalUsd:200});
  expect(parsePublicLiquidation(raw,"ETHUSDT")).toBeNull();
  expect(parsePublicLiquidation("{}","BTCUSDT")).toBeNull();
});
