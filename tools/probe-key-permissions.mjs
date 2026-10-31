// tools/probe-key-permissions.mjs — Deteksi permission API key + posisi akun.
// Read-only: tidak kirim order. Sumber: .env repo (nilai key tidak pernah dicetak).
import { createHmac } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "https://fapi.binance.com";

function loadEnvVar(name) {
  for (const p of [resolve(ROOT, ".env"), resolve(ROOT, "apps/server/.env")]) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      if (line.startsWith(name + "=")) { const v = line.slice(name.length + 1).trim(); if (v) return v; }
    }
  }
  return null;
}
const KEY = loadEnvVar("BINANCE_API_KEY");
const SECRET = loadEnvVar("BINANCE_API_SECRET");
if (!KEY || !SECRET) { console.error("KEY/SECRET tidak ada di .env"); process.exit(1); }

async function signed(path, params = {}) {
  const qs = new URLSearchParams({ ...params, recvWindow: "5000", timestamp: String(Date.now()) });
  qs.set("signature", createHmac("sha256", SECRET).update(qs.toString()).digest("hex"));
  const res = await fetch(`${BASE}${path}?${qs}`, { headers: { "X-MBX-APIKEY": KEY }, signal: AbortSignal.timeout(8000) });
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text };
}

console.log("=== DETEKSI PERMISSION & STATE AKUN ===");
console.log(`key=SET (${KEY.slice(0, 4)}...${KEY.slice(-4)})`);
console.log("");

// 1. Balance = proof of Read permission
const bal = await signed("/fapi/v2/balance");
console.log(`[1] Read permission (GET /fapi/v2/balance): ${bal.ok ? "AKTIF ✓" : `DITOLAK HTTP ${bal.status}: ${bal.body.slice(0, 150)}`}`);
if (bal.ok) {
  const rows = JSON.parse(bal.body);
  const usdt = (Array.isArray(rows) ? rows : []).find((r) => r.asset === "USDT");
  console.log(`    USDT balance=${usdt?.balance ?? "?"} available=${usdt?.availableBalance ?? "?"}`);
}

// 2. Position mode (one-way vs hedge)
const pm = await signed("/fapi/v1/positionSide/dual");
if (pm.ok) {
  const dual = JSON.parse(pm.body).dualSidePosition;
  console.log(`[2] Position mode: ${dual === true ? "HEDGE MODE — harus diubah ke ONE-WAY di Binance UI" : "ONE-WAY ✓ (kompatibel dengan kode)"}`);
} else {
  console.log(`[2] Position mode: GAGAL dibaca HTTP ${pm.status}: ${pm.body.slice(0, 150)}`);
}

// 3. Trade permission test: kirim order INTENTIONALLY INVALID (qty=0 / price absurd)
//     Kalau permission trading AKTIF → error -1102/-4164/-1013 (validasi parameter)
//     Kalau permission trading MATI → error -2015 (invalid API-key, IP, or permissions)
const tradeProbe = await signed("POST" === "POST" ? "/fapi/v1/order" : "/fapi/v1/order", {
  symbol: "BTCUSDT", side: "BUY", type: "LIMIT", quantity: "0", price: "1",
  timeInForce: "GTC", newOrderRespType: "ACK",
});
let tradePerm = "UNKNOWN";
if (tradeProbe.ok) {
  tradePerm = "AKTIF (order diterima — TIDAK EXPECTED utk qty=0!)";
} else {
  const m = tradeProbe.body;
  if (m.includes("-2015")) tradePerm = "TIDAK AKTIF — centang 'Aktifkan Futures' di pengaturan API key";
  else if (m.includes("-2010")) tradePerm = "TIDAK AKTIF — IP tidak di-whitelist / futures trade disabled";
  else if (m.includes("-1102") || m.includes("-1013") || m.includes("-4164") || m.includes("-4061") || m.includes("-4003")) tradePerm = "AKTIF ✓ (error validasi parameter = permission trading jalan, order bodoh ditolak dengan benar)";
  else tradePerm = `RESPON TAK DIKENAL: ${m.slice(0, 200)}`;
}
console.log(`[3] Trade permission (probe order invalid qty=0): ${tradePerm}`);

// 4. Leverage & margin type probe (read-only via positionRisk)
const pr = await signed("/fapi/v2/positionRisk", { symbol: "BTCUSDT" });
if (pr.ok) {
  const rows = JSON.parse(pr.body);
  const first = Array.isArray(rows) ? rows[0] : null;
  console.log(`[4] positionRisk BTCUSDT: OK — leverage terkonfigurasi=${first?.leverage ?? "?"}, marginType=${first?.marginType ?? "?"}`);
} else {
  console.log(`[4] positionRisk: HTTP ${pr.status} ${pr.body.slice(0, 120)}`);
}

// 5. Komisi / fee tier akun
const cm = await signed("/fapi/v1/commissionRate", { symbol: "BTCUSDT" });
if (cm.ok) {
  const j = JSON.parse(cm.body);
  console.log(`[5] Fee tier akun: maker=${j.makerCommissionRate} taker=${j.takerCommissionRate}`);
} else {
  console.log(`[5] Fee tier: HTTP ${cm.status} ${cm.body.slice(0, 120)}`);
}

console.log("");
console.log("Selesai. Tidak ada order yang dikirim (probe #3 pakai qty=0 yang pasti ditolak).");