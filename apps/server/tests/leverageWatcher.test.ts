// apps/server/tests/leverageWatcher.test.ts - uji OFFLINE Leverage Watcher (FR-16, FR-33, US-14).
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  buildSignedQuery,
  LeverageWatcher,
  parseMaxLeverageFromBrackets,
  signHmacSha256,
  type LeverageHistoryItem,
  type LeverageRepo,
  REASON_NO_SNAPSHOT,
  REASON_STALE_SNAPSHOT,
} from "../src/universe/leverageWatcher.js";

function fakeLeverageRepo() {
  const symbols = new Map<string, { symbol: string; maxLeverage: number | null; maxLeverageUpdatedAt: Date | null }>();
  const history: LeverageHistoryItem[] = [];

  const repo: LeverageRepo = {
    async getSymbols(sym?: string) {
      if (sym) {
        const item = symbols.get(sym);
        return item ? [item] : [];
      }
      return Array.from(symbols.values());
    },
    async updateSymbolLeverage(sym: string, maxLeverage: number, updatedAt: Date) {
      symbols.set(sym, { symbol: sym, maxLeverage, maxLeverageUpdatedAt: updatedAt });
    },
    async touchSymbolLeverage(sym: string, updatedAt: Date) {
      const cur = symbols.get(sym);
      if (cur) cur.maxLeverageUpdatedAt = updatedAt;
    },
    async recordHistory(item: Omit<LeverageHistoryItem, "id">) {
      history.push({ ...item, id: history.length + 1 });
    },
    async getHistory(sym?: string, limit = 50) {
      const filtered = sym ? history.filter((h) => h.symbol === sym) : history;
      return [...filtered].reverse().slice(0, limit);
    },
  };

  return { repo, symbols, history };
}

describe("Signature HMAC SHA256", () => {
  it("menghasilkan hash hex valid", () => {
    const sig = signHmacSha256("timestamp=1000&recvWindow=5000", "testsecret");
    expect(sig).toMatch(/^[a-f0-9]{64}$/);
  });

  it("buildSignedQuery menyertakan query + signature", () => {
    const q = buildSignedQuery({ timestamp: 1000, recvWindow: 5000 }, "secret123");
    expect(q).toContain("timestamp=1000");
    expect(q).toContain("signature=");
  });
});

describe("parseMaxLeverageFromBrackets", () => {
  it("mengambil initialLeverage tertinggi dari bracket", () => {
    const brackets = [
      { bracket: 1, initialLeverage: 125, notionalCap: 50000 },
      { bracket: 2, initialLeverage: 100, notionalCap: 100000 },
    ];
    expect(parseMaxLeverageFromBrackets(brackets)).toBe(125);
  });

  it("mengembalikan null jika brackets kosong atau tidak ada", () => {
    expect(parseMaxLeverageFromBrackets([])).toBeNull();
    expect(parseMaxLeverageFromBrackets(undefined)).toBeNull();
  });
});

describe("LeverageWatcher Seed & Signed Sync", () => {
  it("seedManual memperbarui simbol dan mencatat riwayat seed-manual", async () => {
    const { repo, symbols, history } = fakeLeverageRepo();
    const watcher = new LeverageWatcher({ repo, now: () => 100_000 });
    const res = await watcher.seedManual({ BTCUSDT: 125, ETHUSDT: 100 });

    expect(res.updated).toBe(2);
    expect(symbols.get("BTCUSDT")?.maxLeverage).toBe(125);
    expect(history.length).toBe(2);
    expect(history[0].source).toBe("seed-manual");
    expect(history[0].previousMaxLeverage).toBeNull();
  });

  it("syncSigned menarik bracket signed, memetakan maxLev, dan mencatat riwayat", async () => {
    const { repo, symbols, history } = fakeLeverageRepo();
    const watcher = new LeverageWatcher({ repo, now: () => 200_000 });

    const mockFetcher = async () => ({
      data: [
        { symbol: "SOLUSDT", brackets: [{ bracket: 1, initialLeverage: 50 }] },
        { symbol: "DOGEUSDT", brackets: [{ bracket: 1, initialLeverage: 75 }] },
      ],
    });

    const res = await watcher.syncSigned(mockFetcher, "fake-key", "fake-secret");
    expect(res.updated).toBe(2);
    expect(symbols.get("SOLUSDT")?.maxLeverage).toBe(50);
    expect(symbols.get("DOGEUSDT")?.maxLeverage).toBe(75);
    expect(history.length).toBe(2);
    expect(history[0].source).toBe("signed-endpoint");
  });
});

describe("US-14 AC-14: Diff Siklus 6 Jam", () => {
  it("perubahan maxLev UNIUSDT 5x -> 50x memicu diff & entri riwayat baru", async () => {
    const { repo, history } = fakeLeverageRepo();
    const diffsEmitted: any[] = [];
    let fakeTime = 1_000_000;
    const watcher = new LeverageWatcher({
      repo,
      now: () => fakeTime,
      onDiffDetected: (diff) => diffsEmitted.push(diff),
    });

    // Siklus awal: UNIUSDT = 5x
    await watcher.seedManual({ UNIUSDT: 5, BTCUSDT: 125 });
    expect(history.length).toBe(2);

    diffsEmitted.length = 0; // reset sebelum siklus 6 jam berikutnya

    // Siklus berikutnya (6 jam kemudian): UNIUSDT berubah ke 50x, BTCUSDT tetap 125x
    fakeTime += 6 * 3600 * 1000;
    const res = await watcher.applySnapshot(
      [
        { symbol: "UNIUSDT", maxLeverage: 50 },
        { symbol: "BTCUSDT", maxLeverage: 125 },
      ],
      "signed-endpoint"
    );

    expect(res.updated).toBe(1); // hanya UNIUSDT yang berubah
    expect(res.unchanged).toBe(1); // BTCUSDT tetap
    expect(diffsEmitted.length).toBe(1);
    expect(diffsEmitted[0].symbol).toBe("UNIUSDT");
    expect(diffsEmitted[0].old).toBe(5);
    expect(diffsEmitted[0].new).toBe(50);

    // Riwayat UNIUSDT kedua mencatat previousMaxLeverage = 5
    const uniHist = history.filter((h) => h.symbol === "UNIUSDT");
    expect(uniHist.length).toBe(2);
    expect(uniHist[1].previousMaxLeverage).toBe(5);
    expect(uniHist[1].maxLeverage).toBe(50);
    expect(uniHist[1].source).toBe("signed-endpoint");
  });
});

describe("FR-16: Aturan Leverage Efektif & Staleness", () => {
  it("leverage efektif = min(25, maxLev)", async () => {
    const { repo } = fakeLeverageRepo();
    const watcher = new LeverageWatcher({ repo, now: () => 1_000, targetLeverage: 25 });
    await watcher.seedManual({ BTCUSDT: 125, SMALLUSDT: 10 });

    const btcCheck = await watcher.checkLeverage("BTCUSDT");
    expect(btcCheck.valid).toBe(true);
    expect(btcCheck.effectiveLeverage).toBe(25); // min(25, 125) = 25

    const smallCheck = await watcher.checkLeverage("SMALLUSDT");
    expect(smallCheck.valid).toBe(true);
    expect(smallCheck.effectiveLeverage).toBe(10); // min(25, 10) = 10
  });

  it("tanpa snapshot leverage ditolak dengan NO_LEVERAGE_SNAPSHOT", async () => {
    const { repo } = fakeLeverageRepo();
    const watcher = new LeverageWatcher({ repo, now: () => 1_000 });
    const res = await watcher.checkLeverage("UNKNOWNUSDT");
    expect(res.valid).toBe(false);
    expect(res.reason).toBe(REASON_NO_SNAPSHOT);
  });

  it("snapshot lebih tua dari 7 hari ditolak dengan STALE_LEVERAGE_SNAPSHOT", async () => {
    const { repo } = fakeLeverageRepo();
    let fakeTime = 100_000;
    const watcher = new LeverageWatcher({ repo, now: () => fakeTime });
    await watcher.seedManual({ BTCUSDT: 125 });

    // Lewatkan waktu 7 hari + 1 detik
    fakeTime += 7 * 24 * 3600 * 1000 + 1000;
    const res = await watcher.checkLeverage("BTCUSDT");
    expect(res.valid).toBe(false);
    expect(res.reason).toBe(REASON_STALE_SNAPSHOT);
  });
});

describe("FR-33: API /api/universe/leverage", () => {
  it("GET /api/universe/leverage mengembalikan pairs dan history", async () => {
    const app = createApp();
    const res = await request(app).get("/api/universe/leverage").set("x-api-token", "vitest-mutation-token").expect(200);
    expect(res.body).toHaveProperty("pairs");
    expect(res.body).toHaveProperty("history");
    expect(Array.isArray(res.body.pairs)).toBe(true);
    expect(Array.isArray(res.body.history)).toBe(true);
  });
});