// apps/server/tests/tvBridge.test.ts - Uji Webhook Receiver TV & Pine Helper Generator (FR-36, FR-38).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { generatePineScript, processTradingViewWebhook } from "../src/tv/tvBridge.js";
import { env } from "../src/core/env.js";

// Secret FAKE untuk test. Fallback statis sudah dihapus (fail-closed),
// jadi test TIDAK boleh memakai nilai hard-coded apa pun.
const FAKE_TV_SECRET = "fake-tv-webhook-secret";

let originalTvSecret = "";

beforeEach(() => {
  originalTvSecret = env.TV_WEBHOOK_SECRET;
  env.TV_WEBHOOK_SECRET = FAKE_TV_SECRET;
});

afterEach(() => {
  env.TV_WEBHOOK_SECRET = originalTvSecret;
});

describe("FR-36 & FR-38: TradingView Webhook Receiver & Pine Helper", () => {
  it("FR-38: generatePineScript menghasilkan skrip Pine v5 lengkap 3 level single target + alertcondition", () => {
    const script = generatePineScript({
      symbol: "BTCUSDT",
      side: "LONG",
      entryPrice: 60000,
      slPrice: 59400,
      tp1Price: 60600,
    });

    expect(script).toContain("//@version=5");
    expect(script).toContain("indicator(");
    expect(script).toContain('plot(entryPrice, title="ENTRY"');
    expect(script).toContain('plot(slPrice,    title="SL"');
    expect(script).toContain('plot(tp1Price,   title="TP1"');
    expect(script).not.toContain('plot(tp2Price');
    expect(script).toContain('alertcondition(hitTp1');
    expect(script).not.toContain('alertcondition(hitTp2');
    expect(script).toContain('alertcondition(hitSl');
  });

  it("FR-36: Webhook TradingView menolak jika token tidak cocok", async () => {
    const res = await processTradingViewWebhook(
      {
        symbol: "BTCUSDT",
        action: "TP1",
        price: 60600,
      },
      "wrong_token"
    );

    expect(res.success).toBe(false);
    expect(res.message).toContain("tidak valid");
  });

  it("FR-36: Webhook TradingView menyimpan event <= 500ms saat token cocok", async () => {
    const token = FAKE_TV_SECRET;
    const res = await processTradingViewWebhook(
      {
        symbol: "ETHUSDT",
        action: "TP1",
        price: 3200,
      },
      token
    );

    expect(res.success).toBe(true);
    expect(res.latencyMs).toBeLessThanOrEqual(500); // FR-36 <= 500 ms
  });

  it("API POST /api/tv/pine dan POST /api/tv/webhook berfungsi", async () => {
    const app = createApp();

    const pineRes = await request(app).post("/api/tv/pine").set("x-api-token", "vitest-mutation-token")
      .send({
        symbol: "SOLUSDT",
        side: "LONG",
        entryPrice: 150,
        slPrice: 147,
        tp1Price: 153,
      })
      .expect(200);

    expect(pineRes.body.script).toBeDefined();
    expect(pineRes.body.script).toContain("SOLUSDT");

    const token = FAKE_TV_SECRET;
    const hookRes = await request(app).post("/api/tv/webhook").set("x-api-token", "vitest-mutation-token")
      .set("x-tv-token", token)
      .send({
        symbol: "SOLUSDT",
        action: "SL",
        price: 147,
      })
      .expect(200);

    expect(hookRes.body.success).toBe(true);
  });

  it("FR-36: webhook ditolak saat TV_WEBHOOK_SECRET kosong (tidak ada fallback statis)", async () => {
    env.TV_WEBHOOK_SECRET = "";

    const res = await processTradingViewWebhook(
      {
        symbol: "BTCUSDT",
        action: "TP1",
        price: 60600,
      },
      FAKE_TV_SECRET
    );

    expect(res.success).toBe(false);
    expect(res.message).toContain("tidak valid");
    // Respon tidak boleh membocorkan nilai secret.
    expect(res.message).not.toContain(FAKE_TV_SECRET);
  });

  it("FR-36: webhook ditolak saat TV_WEBHOOK_SECRET hanya berisi spasi", async () => {
    env.TV_WEBHOOK_SECRET = "   ";

    const res = await processTradingViewWebhook(
      {
        symbol: "BTCUSDT",
        action: "TP1",
        price: 60600,
      },
      FAKE_TV_SECRET
    );

    expect(res.success).toBe(false);
  });

  it("FR-36: fallback statis lama 'artatrade_webhook_secret' tidak lagi dipakai", async () => {
    env.TV_WEBHOOK_SECRET = "";

    const res = await processTradingViewWebhook(
      {
        symbol: "BTCUSDT",
        action: "TP1",
        price: 60600,
      },
      "artatrade_webhook_secret"
    );

    expect(res.success).toBe(false);
  });
});
