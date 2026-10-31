// tools/test-binance-order.mjs — Probe READ-ONLY Binance USDⓈ-M Futures.
//
// Menjawab "bener bisa kirim order ga?" TANPA mengirim order:
//   1) bukti kredensial + signing HMAC diterima Binance (signed call sukses),
//   2) mode posisi one-way (dualSidePosition=false) sesuai kode client,
//   3) aturan lot/harga/notional pair dari exchange,
//   4) dry-run qty untuk risk $1 (keputusan operator 10 Okt 2026).
//
// Pakai:  node tools/test-binance-order.mjs [SYMBOL]    (default BTCUSDT)
// Key hanya dibaca dari .env; yang dicetak cuma 4 karakter awal/akhir.

import { createHmac } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SYMBOL = (process.argv[2] || "BTCUSDT").toUpperCase();
const RISK_USD = 1;              // keputusan operator: risk LIVE tetap $1
const ASSUMED_SL_PCT = 0.019;    // median jarak SL history paper = 1.925%
const LEVERAGE = 25;             // LEVERAGE_TARGET di .env
const BASE = "https://fapi.binance.com";

function loadEnvVar(name) {
  for (const p of [resolve(ROOT, ".env"), resolve(ROOT, "apps/server/.env")]) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      if (line.startsWith(name + "=")) {
        const v = line.slice(name.length + 1).trim();
        if (v) return v;
      }
    }
  }
  return null;
}

const API_KEY = loadEnvVar("BINANCE_API_KEY");
const API_SECRET = loadEnvVar("BINANCE_API_SECRET");
if (!API_KEY || !API_SECRET) {
  console.error("GAGAL: BINANCE_API_KEY / BINANCE_API_SECRET tidak ditemukan di .env");
  process.exit(1);
}
console.log(`[probe] simbol=${SYMBOL} key=SET (${API_KEY.slice(0, 4)}...${API_KEY.slice(-4)})`);

async function publicJson(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}${path}${qs ? `?${qs}` : ""}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`PUBLIC ${path} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function signedJson(path, params = {}) {
  const qs = new URLSearchParams({ ...params, recvWindow: "5000", timestamp: String(Date.now()) });
  qs.set("signature", createHmac("sha256", API_SECRET).update(qs.toString()).digest("hex"));
  const res = await fetch(`${BASE}${path}?${qs}`, { headers: { "X-MBX-APIKEY": API_KEY }, signal: AbortSignal.timeout(8000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`SIGNED ${path} HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

let fail = 0;
async function step(label, fn) {
  try {
    const out = await fn();
    console.log(`[OK]    ${label}`);
    return out;
  } catch (err) {
    fail++;
    console.log(`[GAGAL] ${label} -> ${err.message}`);
    return null;
  }
}

// 1. Drift waktu server (signed request butuh di bawah recvWindow)
await step("waktu server Binance (GET /fapi/v1/time)", async () => {
  const j = await publicJson("/fapi/v1/time");
  console.log(`        drift lokal-server: ${Date.now() - Number(j.serverTime)} ms`);
  return j;
});

// 2. Saldo futures (signed) — bukti kredensial + permission futures
const balance = await step("saldo futures (GET /fapi/v2/balance, signed)", async () => {
  const rows = await signedJson("/fapi/v2/balance");
  const usdt = (Array.isArray(rows) ? rows : []).find((r) => r.asset === "USDT");
  if (!usdt) throw new Error("aset USDT tidak ditemukan di respons balance");
  console.log(`        USDT balance=${usdt.balance} availableBalance=${usdt.availableBalance}`);
  return usdt;
});

// 3. Mode posisi — client kirim positionSide=BOTH, akun harus one-way
await step("mode posisi (GET /fapi/v1/positionSide/dual, signed)", async () => {
  const j = await signedJson("/fapi/v1/positionSide/dual");
  console.log(`        dualSidePosition=${j.dualSidePosition} (kode butuh false/one-way)`);
  if (j.dualSidePosition !== false) throw new Error("akun hedge-mode; ubah ke one-way dulu di Binance sebelum LIVE");
  return j;
});

// 4. Aturan pair (publik)
const info = await step(`aturan pair ${SYMBOL} (exchangeInfo)`, async () => {
  const j = await publicJson("/fapi/v1/exchangeInfo", { symbol: SYMBOL });
  const sym = j.symbols?.[0];
  if (!sym) throw new Error("simbol tidak ditemukan di exchangeInfo");
  const lot = sym.filters.find((f) => f.filterType === "LOT_SIZE") ?? {};
  const pf = sym.filters.find((f) => f.filterType === "PRICE_FILTER") ?? {};
  const mn = sym.filters.find((f) => f.filterType === "MIN_NOTIONAL") ?? {};
  console.log(`        status=${sym.status} stepSize=${lot.stepSize} minQty=${lot.minQty} tickSize=${pf.tickSize} minNotional=${mn.notional}`);
  return { lot, pf, mn };
});

// 5. Harga terakhir + posisi terbuka pair ini (read-only)
const priceRow = await step(`harga terakhir ${SYMBOL} (ticker/price)`, async () => {
  const j = await publicJson("/fapi/v1/ticker/price", { symbol: SYMBOL });
  console.log(`        price=${j.price}`);
  return j;
});
await step(`posisi terbuka ${SYMBOL} (positionRisk, signed)`, async () => {
  const rows = await signedJson("/fapi/v2/positionRisk", { symbol: SYMBOL });
  const pos = (Array.isArray(rows) ? rows : []).find((r) => Number(r.positionAmt) !== 0);
  console.log(pos ? `        ADA posisi terbuka: amt=${pos.positionAmt} entry=${pos.entryPrice}` : "        tidak ada posisi terbuka");
  return rows;
});

// 6. DRY-RUN sizing risk $1 — semua angka dihitung di kode
if (info && priceRow) {
  const price = Number(priceRow.price);
  const stepSize = Number(info.lot.stepSize);
  const minQty = Number(info.lot.minQty);
  const minNotional = Number(info.mn.notional ?? 0);
  if (Number.isFinite(price) && price > 0 && Number.isFinite(stepSize) && stepSize > 0) {
    const stopDistance = price * ASSUMED_SL_PCT;
    const rawQty = RISK_USD / stopDistance;
    const qty = Math.floor(rawQty / stepSize) * stepSize;
    const notional = qty * price;
    const margin = notional / LEVERAGE;
    const qtyStr = qty.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
    console.log(`[dry-run] risk=$1, asumsi jarak SL ${ASSUMED_SL_PCT * 100}% dari entry:`);
    console.log(`        qty=${qtyStr}  notional=$${notional.toFixed(2)}  margin@${LEVERAGE}x=$${margin.toFixed(2)}`);
    console.log(`        minQty=${minQty} -> ${qty >= minQty ? "MEMENUHI" : "DI BAWAH MINIMUM (order pasti ditolak)"}`);
    if (minNotional > 0) console.log(`        minNotional=$${minNotional} -> ${notional >= minNotional ? "MEMENUHI" : "DI BAWAH MINIMUM (order pasti ditolak)"}`);
    if (balance) {
      const avail = Number(balance.availableBalance);
      console.log(`        availableBalance=$${avail} vs kebutuhan margin $${margin.toFixed(2)} -> ${avail >= margin ? "CUKUP" : "KURANG"}`);
    }
  } else {
    console.log("[dry-run] dilewati: harga/stepSize tidak valid");
  }
}

console.log("");
if (fail === 0) {
  console.log("VERDICT: kredensial DITERIMA Binance futures (semua signed call sukses).");
  console.log("Probe ini TIDAK mengirim order. Jalur kirim order = wiring apps/server yang belum dicolok.");
} else {
  console.log(`VERDICT: ${fail} langkah gagal — bereskan baris [GAGAL] di atas sebelum LIVE.`);
}
process.exit(fail === 0 ? 0 : 1);