import { afterEach, expect, it, vi } from "vitest";
import { fetchPublicDepth } from "./publicDepth.js";
afterEach(()=>vi.unstubAllGlobals());
it("uses only unsigned public GET data and normalizes explicit venue schemas", async()=>{
  const fetch = vi.fn().mockResolvedValueOnce({ok:true,json:async()=>({E:123,bids:[["100","2"]],asks:[["101","3"]]})})
    .mockResolvedValueOnce({ok:true,json:async()=>({retCode:0,result:{ts:124,b:[["100","1"]],a:[["101","1"]]}})});
  vi.stubGlobal("fetch",fetch);
  const signal = new AbortController().signal;
  expect((await fetchPublicDepth("BTCUSDT","BINANCE",signal)).serverTime).toBe(123);
  expect((await fetchPublicDepth("BTCUSDT","BYBIT",signal)).serverTime).toBe(124);
  for(const [url,opts] of fetch.mock.calls){ expect(url).not.toMatch(/order\?|account|apiKey|signature/);expect(opts).toMatchObject({method:"GET",credentials:"omit"}); }
  expect(fetch.mock.calls[1][0]).toContain("category=linear");
});
it("rejects rate limits and exchange errors instead of showing an empty successful snapshot",async()=>{
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue({ok:false,status:429}));
  await expect(fetchPublicDepth("BTCUSDT","BINANCE",new AbortController().signal)).rejects.toThrow("429");
});
