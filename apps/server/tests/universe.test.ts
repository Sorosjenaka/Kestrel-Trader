// apps/server/tests/universe.test.ts - uji OFFLINE Universe Manager (FR-01, FR-02, US-03).
import { describe, expect, it, afterEach } from "vitest";
import { classifyExchangeSymbol, toSymbolRow, UniverseManager, type RawSymbol, type SymbolRow, type SyncStats, type UniverseRepo } from "../src/universe/universeManager.js";
import { setExchangePerpUniverse, isPerpListed, perpUniverseCount, clearExchangePerpUniverse } from "../src/universe/assetClassGuard.js";

afterEach(() => { clearExchangePerpUniverse(); });

const sample: RawSymbol[] = [
  { symbol: "BTCUSDT", contractType: "PERPETUAL", status: "TRADING", baseAsset: "BTC", quoteAsset: "USDT", underlyingType: "COIN",
    filters: [{ filterType: "MIN_NOTIONAL", notional: "50" }, { filterType: "PRICE_FILTER", tickSize: "0.10" }, { filterType: "LOT_SIZE", stepSize: "0.001" }] },
  { symbol: "QQQUSDT", contractType: "TRADIFI_PERPETUAL", status: "TRADING", baseAsset: "QQQ", quoteAsset: "USDT", underlyingType: "EQUITY", filters: [] },
  { symbol: "XAUUSDT", contractType: "TRADIFI_PERPETUAL", status: "TRADING", baseAsset: "XAU", quoteAsset: "USDT", underlyingType: "COMMODITY", filters: [] },
  { symbol: "BTCDOMUSDT", contractType: "PERPETUAL", status: "TRADING", baseAsset: "BTCDOM", quoteAsset: "USDT", underlyingType: "INDEX", filters: [] },
  { symbol: "OLDUSDT", contractType: "PERPETUAL", status: "BREAK", baseAsset: "OLD", quoteAsset: "USDT", underlyingType: "COIN", filters: [] },
  { symbol: "ABCUSDC", contractType: "PERPETUAL", status: "TRADING", baseAsset: "ABC", quoteAsset: "USDC", underlyingType: "COIN", filters: [] },
];

function fakeRepo(manual: string[] = []) {
  const rows = new Map<string, SymbolRow>();
  const repo: UniverseRepo = {
    async getManualBlacklist() { return manual; },
    async upsertSymbol(row) { rows.set(row.symbol, row); },
  };
  return { repo, rows };
}

function managerWith(payload: unknown, repo: UniverseRepo, events: string[] = []) {
  return new UniverseManager({
    get: async () => ({ data: payload as { symbols: RawSymbol[] } }),
    repo,
    intervalMs: 60_000,
    now: () => 1234,
    onEvent: (type, payload2) => events.push(type),
  });
}

describe("classifyExchangeSymbol (FR-01, FR-02)", () => {
  it("simbol crypto lengkap = tradeable (bukan blacklist)", () => {
    expect(classifyExchangeSymbol(sample[0], new Set())).toEqual({ blacklist: false, reason: null });
  });

  it("deny-by-default: EQUITY, COMMODITY, INDEX, status, quote ditolak dengan alasan tepat", () => {
    expect(classifyExchangeSymbol(sample[1], new Set()).reason).toBe("non-crypto:EQUITY");
    expect(classifyExchangeSymbol(sample[2], new Set()).reason).toBe("non-crypto:COMMODITY");
    expect(classifyExchangeSymbol(sample[3], new Set()).reason).toBe("BTCDOM-data-only");
    expect(classifyExchangeSymbol(sample[4], new Set()).reason).toBe("status:BREAK");
    expect(classifyExchangeSymbol(sample[5], new Set()).reason).toBe("quote:USDC");
  });

  it("fan token TIDAK pernah ditrade (operator 16 Okt 2026): base fan -> fan-token:operator", () => {
    const fan: RawSymbol = { symbol: "ASRUSDT", contractType: "PERPETUAL", status: "TRADING", baseAsset: "ASR", quoteAsset: "USDT", underlyingType: "COIN", filters: [] };
    const og: RawSymbol = { symbol: "OGUSDT", contractType: "PERPETUAL", status: "TRADING", baseAsset: "OG", quoteAsset: "USDT", underlyingType: "COIN", filters: [] };
    expect(classifyExchangeSymbol(fan, new Set())).toEqual({ blacklist: true, reason: "fan-token:operator" });
    expect(classifyExchangeSymbol(og, new Set()).reason).toBe("fan-token:operator");
    // non-fan tetap lolos
    expect(classifyExchangeSymbol(sample[0], new Set()).blacklist).toBe(false);
  });

  it("blacklist manual SELALU menang di atas klasifikasi", () => {
    const r = classifyExchangeSymbol(sample[0], new Set(["BTCUSDT"]));
    expect(r).toEqual({ blacklist: true, reason: "manual" });
  });

  it("toSymbolRow memetakan filter exchangeInfo (minNotional/tick/step)", () => {
    const row = toSymbolRow(sample[0], new Set());
    expect(row.isBlacklisted).toBe(false);
    expect(row.minNotional).toBe(50);
    expect(row.tickSize).toBe(0.1);
    expect(row.stepSize).toBe(0.001);
    const qq = toSymbolRow(sample[1], new Set());
    expect(qq.isBlacklisted).toBe(true);
    expect(qq.blacklistReason).toBe("non-crypto:EQUITY");
  });
});

describe("UniverseManager.syncOnce", () => {
  it("sync 6 simbol sample: 1 tradeable, 5 blacklist, statistik benar + event SYNC_OK", async () => {
    const { repo, rows } = fakeRepo();
    const events: string[] = [];
    const mgr = managerWith({ symbols: sample }, repo, events);
    const stats: SyncStats = await mgr.syncOnce();
    expect(stats.total).toBe(6);
    expect(stats.tradeable).toBe(1);
    expect(stats.blacklisted).toBe(5);
    expect(stats.byReason["non-crypto:EQUITY"]).toBe(1);
    expect(stats.byReason["BTCDOM-data-only"]).toBe(1);
    expect(stats.atMs).toBe(1234);
    expect(events).toContain("SYNC_OK");
    expect(rows.size).toBe(6);
    expect(rows.get("BTCUSDT")?.isBlacklisted).toBe(false);
    expect(rows.get("BTCDOMUSDT")?.blacklistReason).toBe("BTCDOM-data-only");
    const s = mgr.stats();
    expect(s.lastSyncAtMs).toBe(1234);
    expect(s.lastError).toBeNull();
    expect(s.manualCount).toBe(0);
  });

  it("blacklist manual mengubah BTCUSDT menjadi blacklist saat sync", async () => {
    const { repo, rows } = fakeRepo(["BTCUSDT"]);
    const mgr = managerWith({ symbols: sample }, repo);
    await mgr.syncOnce();
    expect(rows.get("BTCUSDT")?.isBlacklisted).toBe(true);
    expect(rows.get("BTCUSDT")?.blacklistReason).toBe("manual");
    expect(mgr.stats().manualCount).toBe(1);
    expect(mgr.stats().lastStats!.tradeable).toBe(0);
  });

  it("gagal fetch -> event SYNC_FAIL + error tercatat + error dilempar", async () => {
    const { repo } = fakeRepo();
    const events: string[] = [];
    const mgr = new UniverseManager({
      get: async () => { throw new Error("jaringan dicegat"); },
      repo,
      onEvent: (type) => events.push(type),
    });
    await expect(mgr.syncOnce()).rejects.toThrow("jaringan dicegat");
    expect(events).toContain("SYNC_FAIL");
    expect(mgr.stats().lastError).toContain("dicegat");
    expect(mgr.stats().lastSyncAtMs).toBeNull();
  });
  it("endpoint /api/universe/audit mengembalikan metrik universe dan leverage (FR-33)", async () => {
    const { createApp } = await import("../src/app.js");
    const request = (await import("supertest")).default;
    const app = createApp();

    const res = await request(app).get("/api/universe/audit").set("x-api-token", "vitest-mutation-token").expect(200);
    expect(res.body.totalSymbols).toBeGreaterThanOrEqual(0);
    expect(res.body.nonCryptoFiltered).toBe(204);
    expect(Array.isArray(res.body.symbols)).toBe(true);
  });

});

describe("Allowlist PERPETUAL (ONLY FUTURES, perintah operator 26 Sep 2026)", () => {
  it("kosong = fail-open (null): UI tidak brick sebelum sync pertama", () => {
    expect(perpUniverseCount()).toBe(0);
    expect(isPerpListed("BTCUSDT")).toBeNull();
    expect(isPerpListed("FAKEUSDT")).toBeNull();
  });

  it("terisi = anggota lolos, non-anggota ditolak (spot/delivery/settling)", () => {
    expect(setExchangePerpUniverse(["BTCUSDT", "ETHUSDT"])).toBe(2);
    expect(perpUniverseCount()).toBe(2);
    expect(isPerpListed("BTCUSDT")).toBe(true);
    expect(isPerpListed("btcusdt")).toBe(true);
    expect(isPerpListed("TSLAUSDT")).toBe(false);
    expect(isPerpListed("BTCUSDT_261225")).toBe(false);
    expect(isPerpListed("BTCUPUSDT")).toBe(false);
  });

  it("syncOnce mengisi allowlist hanya dengan PERPETUAL+COIN+USDT+TRADING", async () => {
    const { repo } = fakeRepo();
    const mgr = managerWith({ symbols: sample }, repo);
    await mgr.syncOnce();
    // Hanya BTCUSDT yang lolos whitelist (QQQ/XAU EQUITY-COMMODITY, BTCDOM index,
    // OLD status BREAK, ABCUSDC quote USDC).
    expect(perpUniverseCount()).toBe(1);
    expect(isPerpListed("BTCUSDT")).toBe(true);
    expect(isPerpListed("QQQUSDT")).toBe(false);
    expect(isPerpListed("OLDUSDT")).toBe(false);
  });
});