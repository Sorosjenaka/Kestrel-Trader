// apps/server/tests/db.test.ts - smoke SQLite + Prisma (FR-25, NFR-07).
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../src/core/db.js";

describe("SQLite via Prisma", () => {
  it("Setting: tulis-baca-hapus", async () => {
    await db.setting.upsert({
      where: { key: "__smoke" },
      update: { value: "1" },
      create: { key: "__smoke", value: "1" },
    });
    const got = await db.setting.findUnique({ where: { key: "__smoke" } });
    expect(got?.value).toBe("1");
    await db.setting.delete({ where: { key: "__smoke" } });
  });

  it("Symbol: whitelist crypto-only tersimpan + default blacklist false", async () => {
    await db.symbol.upsert({
      where: { symbol: "__SMOKEUSDT" },
      update: {},
      create: { symbol: "__SMOKEUSDT", baseAsset: "__SMOKE", underlyingType: "COIN" },
    });
    const s = await db.symbol.findUnique({ where: { symbol: "__SMOKEUSDT" } });
    expect(s?.underlyingType).toBe("COIN");
    expect(s?.isBlacklisted).toBe(false);
    await db.symbol.delete({ where: { symbol: "__SMOKEUSDT" } });
  });

  afterAll(async () => {
    await db.$disconnect();
  });
});