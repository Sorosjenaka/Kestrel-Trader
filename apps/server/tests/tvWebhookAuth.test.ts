// apps/server/tests/tvWebhookAuth.test.ts - Regression auth exemption webhook TradingView.
//
// Bug yang diuji: middleware global app.ts di-mount "/api/" membandingkan
// req.path (path RELATIF mount = "/tv/webhook") dengan "/api/tv/webhook",
// sehingga perbandingan tidak pernah match -> POST /api/tv/webhook dari
// klien non-loopback selalu 401 di lapis global dan handler TV tidak pernah
// terjangkau (TradingView tidak bisa kirim alert).
//
// Kontrak yang dijaga test ini:
//   1. Exemption hanya POST + path EXACT /api/tv/webhook (bukan prefix /api/tv/*).
//   2. Auth TV sendiri (x-tv-token / payload token, tv.ts + tvBridge.ts) tetap WAJIB.
//   3. Semua endpoint mutasi lain di /api/ tetap wajib x-api-token.
//   4. Perilaku loopback (bypass lokal) tidak berubah.
//
// Fail-closed secret (21 Okt 2026): fallback statis "artatrade_webhook_secret"
// DIHAPUS dari tvBridge.ts. Kalau TV_WEBHOOK_SECRET belum dikonfigurasi
// (undefined / kosong / hanya spasi) TIDAK ADA token yang boleh meniru webhook -
// termasuk nilai fallback statis yang lama.
//
// Semua kredensial = token fake, tanpa jaringan, tanpa order, tanpa secrets nyata.
import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { env } from "../src/core/env.js";

const FAKE_API_TOKEN = "fake-api-mutation-token";
const FAKE_TV_SECRET = "fake-tv-webhook-secret";
// TEST-NET-3 (RFC 5737) - tidak pernah dipakai sungguhan, hanya simulasi klien
// non-loopback yang datang lewat proxy tepercaya (nginx) seperti kasus nyata.
const NON_LOOPBACK_IP = "203.0.113.5";

const app = createApp();

// Layer diagnostik (hanya di instance app in-process test ini, BUKAN di source):
// expose nilai req.ip / req.baseUrl / req.path apa adanya supaya test bisa
// membuktikan (a) IP simulasi benar-benar non-loopback dan (b) semantik path
// di dalam mount "/api/" (path relatif mount + baseUrl).
// Di-mount "/api/" (mount yang SAMA dengan middleware auth global) supaya
// req.baseUrl/req.path di sini identik dengan yang dilihat middleware global.
app.use("/api/", (req, res, next) => {
  if (req.path !== "/__test/echo-request-context") return next();
  res.json({
    ip: req.ip,
    ips: req.ips,
    baseUrl: req.baseUrl,
    path: req.path,
    originalUrl: req.originalUrl,
  });
});

let originalApiToken = "";
let originalTvSecret = "";

beforeEach(() => {
  originalApiToken = env.API_MUTATION_TOKEN;
  originalTvSecret = env.TV_WEBHOOK_SECRET;
  // Aktifkan auth global dengan token fake + secret TV fake.
  env.API_MUTATION_TOKEN = FAKE_API_TOKEN;
  env.TV_WEBHOOK_SECRET = FAKE_TV_SECRET;
});

afterEach(() => {
  env.API_MUTATION_TOKEN = originalApiToken;
  env.TV_WEBHOOK_SECRET = originalTvSecret;
});

const webhookBody = { symbol: "BTCUSDT", action: "TP1" as const, price: 60000 };

describe("Auth webhook TradingView - exemption x-api-token vs auth x-tv-token", () => {
  it("membuktikan IP simulasi non-loopback benar-benar non-loopback (bukan bypass loopback)", async () => {
    const viaProxy = await request(app).get("/api/__test/echo-request-context").set("x-api-token", "vitest-mutation-token")
      .set("X-Forwarded-For", NON_LOOPBACK_IP);
    expect(viaProxy.status).toBe(200);
    expect(viaProxy.body.ip).toBe(NON_LOOPBACK_IP);
    expect(["127.0.0.1", "::1", "::ffff:127.0.0.1"]).not.toContain(viaProxy.body.ip);

    const loopback = await request(app).get("/api/__test/echo-request-context").set("x-api-token", "vitest-mutation-token");
    expect(loopback.status).toBe(200);
    expect(["127.0.0.1", "::1", "::ffff:127.0.0.1"]).toContain(loopback.body.ip);
  });

  it("membuktikan semantik path di dalam mount /api/: req.path relatif mount, req.baseUrl = /api", async () => {
    const res = await request(app).get("/api/__test/echo-request-context").set("x-api-token", "vitest-mutation-token");
    expect(res.status).toBe(200);
    // Path relatif mount (bukan "/api/__test/echo-request-context")...
    expect(res.body.path).toBe("/__test/echo-request-context");
    // ...dan baseUrl mount "/api" -> gabungan = path penuh.
    expect(res.body.baseUrl).toBe("/api");
    expect(res.body.baseUrl + res.body.path).toBe("/api/__test/echo-request-context");
  });

  it("POST /api/tv/webhook non-loopback tanpa x-api-token: Lolos exemption global, ditolak auth TV", async () => {
    const res = await request(app).post("/api/tv/webhook").set("x-api-token", "vitest-mutation-token")
      .set("X-Forwarded-For", NON_LOOPBACK_IP)
      .send(webhookBody);

    // 401 dari LAPIS TV (body punya success/message), BUKAN dari middleware global.
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain("tidak valid");
    expect(res.body.error).toBeUndefined();
  });

  it("POST /api/tv/webhook non-loopback dengan token TV SALAH: tetap ditolak auth TV", async () => {
    const res = await request(app).post("/api/tv/webhook").set("x-api-token", "vitest-mutation-token")
      .set("X-Forwarded-For", NON_LOOPBACK_IP)
      .set("x-tv-token", "token-salah")
      .send(webhookBody);

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain("tidak valid");
    expect(res.body.error).toBeUndefined();
  });

  it("POST /api/tv/webhook non-loopback dengan token TV VALID: mencapai pemrosesan, tidak diblokir lapis global", async () => {
    const res = await request(app).post("/api/tv/webhook").set("x-api-token", "vitest-mutation-token")
      .set("X-Forwarded-For", NON_LOOPBACK_IP)
      .set("x-tv-token", FAKE_TV_SECRET)
      .send(webhookBody);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.latencyMs).toBe("number");
    expect(res.body.error).toBeUndefined();
  });

  it("POST /api/tv/webhook non-loopback tanpa token TV sama sekali: ditolak auth TV", async () => {
    const res = await request(app).post("/api/tv/webhook").set("x-api-token", "vitest-mutation-token")
      .set("X-Forwarded-For", NON_LOOPBACK_IP)
      .send(webhookBody);

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBeUndefined();
  });

  it("endpoint mutasi lain tanpa x-api-token tetap ditolak lapis global", async () => {
    const res = await request(app).post("/api/tv/pine").set("x-api-token", "vitest-mutation-token")
      .set("X-Forwarded-For", NON_LOOPBACK_IP)
      .send({ symbol: "SOLUSDT", side: "LONG", entryPrice: 150, slPrice: 147, tp1Price: 153 });

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("x-api-token");
    expect(res.body.success).toBeUndefined();
  });

  it("endpoint mutasi lain dengan x-api-token valid tetap bisa (perilaku lama)", async () => {
    const res = await request(app).post("/api/tv/pine").set("x-api-token", "vitest-mutation-token")
      .set("X-Forwarded-For", NON_LOOPBACK_IP)
      .set("x-api-token", FAKE_API_TOKEN)
      .send({ symbol: "SOLUSDT", side: "LONG", entryPrice: 150, slPrice: 147, tp1Price: 153 });

    expect(res.status).toBe(200);
    expect(res.body.script).toContain("//@version=5");
  });

  it("path mirip TIDAK mendapat exemption (tanpa prefix matching /api/tv/*)", async () => {
    // "/api/tv/webhook/" dan "/api/tv%2Fwebhook" sengaja ikut diuji: keduanya
    // TIDAK boleh mendapat exemption (fail-closed). URL TV yang dipakai
    // TradingView adalah path exact tanpa trailing slash.
    for (const path of [
      "/api/tv/webhook/extra",
      "/api/tv/webhooks",
      "/api/tv/webhookx",
      "/api/tv/webhook/",
      "/api/tv%2Fwebhook",
    ]) {
      // Kebijakan baru 25 Okt 2026: tanpa token -> 401 (fail-closed; loopback
      // tidak lagi bypass). Exemption hanya POST exact /api/tv/webhook.
      const res = await request(app).post(path)
        .set("X-Forwarded-For", NON_LOOPBACK_IP)
        .send(webhookBody);

      expect(res.status, `path ${path} harus ditolak lapis global`).toBe(401);
      expect(res.body.error, `path ${path} harus ditolak lapis global`).toContain("x-api-token");
      expect(res.body.success).toBeUndefined();
    }
  });

  it("method selain POST pada path webhook TIDAK mendapat exemption", async () => {
    for (const method of ["put", "patch", "delete"] as const) {
      const res = await request(app)
        [method]("/api/tv/webhook")
        .set("X-Forwarded-For", NON_LOOPBACK_IP)
        .send(webhookBody);

      expect(res.status, `method ${method} harus ditolak lapis global`).toBe(401);
      expect(res.body.error, `method ${method} harus ditolak lapis global`).toContain("x-api-token");
      expect(res.body.success).toBeUndefined();
    }
  });

  it("loopback TANPA token DITOLAK lapis global (perilaku BARU 25 Okt 2026)", async () => {
    // Perintah operator FASE 1: loopback bukan otorisasi. POST exact webhook
    // memang exempt (auth sendiri), tapi mutasi lain dari loopback tetap wajib
    // token — uji lewat path non-exact dari loopback.
    const res = await request(app).post("/api/tv/webhook/extra").send(webhookBody);
    expect(res.status).toBe(401);
    expect(res.body.error).toContain("x-api-token");
  });

  it("loopback dengan token TV valid tetap diproses", async () => {
    const res = await request(app).post("/api/tv/webhook").set("x-api-token", "vitest-mutation-token")
      .set("x-tv-token", FAKE_TV_SECRET)
      .send(webhookBody);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ── Fail-closed secret (21 Okt 2026) ────────────────────────────────────────
// Fallback statis "artatrade_webhook_secret" yang tadinya dipakai tvBridge.ts
// saat TV_WEBHOOK_SECRET kosong DIHAPUS. Kalau secret belum dikonfigurasi,
// webhook harus menolak SEMUA token - termasuk nilai fallback yang lama.
describe("Fail-closed secret webhook TradingView (tanpa fallback statis)", () => {
  const STATIC_FALLBACK = "artatrade_webhook_secret";

  it("hanya secret terkonfigurasi yang benar yang lolos; token lain DITOLAK", async () => {
    const wrong = await request(app).post("/api/tv/webhook").set("x-api-token", "vitest-mutation-token")
      .set("X-Forwarded-For", NON_LOOPBACK_IP)
      .set("x-tv-token", "token-salah")
      .send(webhookBody);

    expect(wrong.status).toBe(401);
    expect(wrong.body.success).toBe(false);
    expect(wrong.body.error).toBeUndefined();

    const right = await request(app).post("/api/tv/webhook").set("x-api-token", "vitest-mutation-token")
      .set("X-Forwarded-For", NON_LOOPBACK_IP)
      .set("x-tv-token", FAKE_TV_SECRET)
      .send(webhookBody);

    expect(right.status).toBe(200);
    expect(right.body.success).toBe(true);
  });

  it("TV_WEBHOOK_SECRET kosong: fallback statis lama DITOLAK", async () => {
    env.TV_WEBHOOK_SECRET = "";

    const res = await request(app).post("/api/tv/webhook").set("x-api-token", "vitest-mutation-token")
      .set("X-Forwarded-For", NON_LOOPBACK_IP)
      .set("x-tv-token", STATIC_FALLBACK)
      .send(webhookBody);

    expect(res.status).toBe(401);
    // Ditolak di LAPIS TV (bukan lapis global) - exempt global tetap utuh.
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBeUndefined();
    // Respon tidak boleh membocorkan nilai fallback / nilai secret.
    expect(JSON.stringify(res.body)).not.toContain(STATIC_FALLBACK);
    expect(JSON.stringify(res.body)).not.toContain(FAKE_TV_SECRET);
  });

  it("TV_WEBHOOK_SECRET hanya berisi spasi: fallback statis lama DITOLAK", async () => {
    env.TV_WEBHOOK_SECRET = "   ";

    const res = await request(app).post("/api/tv/webhook").set("x-api-token", "vitest-mutation-token")
      .set("X-Forwarded-For", NON_LOOPBACK_IP)
      .set("x-tv-token", STATIC_FALLBACK)
      .send(webhookBody);

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBeUndefined();
  });

  it("TV_WEBHOOK_SECRET tidak di-set di process.env: loader menghasilkan string KOSONG (bukan fallback) dan fallback statis tetap DITOLAK", async () => {
    const saved = process.env.TV_WEBHOOK_SECRET;
    try {
      delete process.env.TV_WEBHOOK_SECRET;

      // Muat ulang modul env untuk membuktikan apa yang sebenarnya dikembalikan
      // loader saat variabel tidak ada sama sekali.
      vi.resetModules();
      const fresh = await import("../src/core/env.js");
      expect(fresh.env.TV_WEBHOOK_SECRET).toBe("");
      expect(fresh.env.TV_WEBHOOK_SECRET).not.toBe(STATIC_FALLBACK);

      // Lapis auth yang berjalan melihat konfigurasi kosong -> tolak semua token.
      env.TV_WEBHOOK_SECRET = "";
      const res = await request(app).post("/api/tv/webhook").set("x-api-token", "vitest-mutation-token")
        .set("X-Forwarded-For", NON_LOOPBACK_IP)
        .set("x-tv-token", STATIC_FALLBACK)
        .send(webhookBody);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBeUndefined();
    } finally {
      // Pulihkan state process.env asli (wajib: test tidak boleh bergantung urutan).
      if (saved === undefined) delete process.env.TV_WEBHOOK_SECRET;
      else process.env.TV_WEBHOOK_SECRET = saved;
    }
  });

  it("secret terkonfigurasi tetap dipakai: fallback statis yang LAMA tidak berlaku", async () => {
    // env.TV_WEBHOOK_SECRET = FAKE_TV_SECRET (dipasang di beforeEach).
    const withFallback = await request(app).post("/api/tv/webhook").set("x-api-token", "vitest-mutation-token")
      .set("X-Forwarded-For", NON_LOOPBACK_IP)
      .set("x-tv-token", STATIC_FALLBACK)
      .send(webhookBody);

    expect(withFallback.status).toBe(401);
    expect(withFallback.body.success).toBe(false);
    expect(withFallback.body.error).toBeUndefined();
  });

  it("fail-closed tidak menyentuh proteksi global x-api-token untuk endpoint mutasi lain", async () => {
    env.TV_WEBHOOK_SECRET = "";

    const res = await request(app).post("/api/tv/pine").set("x-api-token", "vitest-mutation-token")
      .set("X-Forwarded-For", NON_LOOPBACK_IP)
      .send({ symbol: "SOLUSDT", side: "LONG", entryPrice: 150, slPrice: 147, tp1Price: 153 });

    // Tetap ditolak lapis global (bukan lapis TV) -> proteksi global utuh.
    expect(res.status).toBe(401);
    expect(res.body.error).toContain("x-api-token");
    expect(res.body.success).toBeUndefined();
  });

  it("path mirip tetap di luar exemption meski secret TV tidak terkonfigurasi", async () => {
    env.TV_WEBHOOK_SECRET = "";

    for (const path of ["/api/tv/webhook/extra", "/api/tv/webhooks", "/api/tv/webhookx"]) {
      const res = await request(app).post(path).set("x-api-token", "vitest-mutation-token")
        .set("X-Forwarded-For", NON_LOOPBACK_IP)
        .set("x-tv-token", STATIC_FALLBACK)
        .send(webhookBody);

      expect(res.status, `path ${path} harus ditolak lapis global`).toBe(401);
      expect(res.body.error, `path ${path} harus ditolak lapis global`).toContain("x-api-token");
      expect(res.body.success).toBeUndefined();
    }
  });

  it("perilaku loopback tidak berubah: tanpa token tetap ditolak, dengan secret terkonfigurasi tetap diproses", async () => {
    const anonymous = await request(app).post("/api/tv/webhook").set("x-api-token", "vitest-mutation-token").send(webhookBody);

    expect(anonymous.status).toBe(401);
    expect(anonymous.body.success).toBe(false);
    expect(anonymous.body.error).toBeUndefined();

    const authorized = await request(app).post("/api/tv/webhook").set("x-api-token", "vitest-mutation-token")
      .set("x-tv-token", FAKE_TV_SECRET)
      .send(webhookBody);

    expect(authorized.status).toBe(200);
    expect(authorized.body.success).toBe(true);
  });
});
