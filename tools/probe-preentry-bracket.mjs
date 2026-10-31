// tools/probe-preentry-bracket.mjs — TEST ZERO-RISK: bisakah SL/TP closePosition
// dipasang SEBELUM ada posisi (pre-entry bracket)? Place dengan trigger absurd
// (BTCUSDT 1.000 / 999.999 — mustahil tersentuh) -> baca status -> CANCEL semua.
// Tidak ada posisi yang dibuka; hanya memvalidasi perilaku endpoint algo Binance.
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
if (!KEY || !SECRET) { console.error("KEY/SECRET tidak ada"); process.exit(1); }

async function signed(method, path, fields) {
  const qs = new URLSearchParams({ ...fields, recvWindow: "5000", timestamp: String(Date.now()) });
  qs.set("signature", createHmac("sha256", SECRET).update(qs.toString()).digest("hex"));
  const url = `${BASE}${path}${method === "POST" ? "" : `?${qs}`}`;
  const res = await fetch(url, {
    method,
    headers: { "X-MBX-APIKEY": KEY, ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    ...(method === "POST" ? { body: qs.toString() } : {}),
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text };
}

const stamp = Date.now();
const slId = `PROBE_SL_${stamp}`;
const tpId = `PROBE_TP_${stamp}`;
const out = { placed: [], failures: [] };

// 1) SL: STOP_MARKET closePosition=true, trigger absurd 1.000 (harga 83rb) — SELL utk LONG-safety
const sl = await signed("POST", "/fapi/v1/algoOrder", {
  algoType: "CONDITIONAL", type: "STOP_MARKET", symbol: "BTCUSDT",
  side: "SELL", positionSide: "BOTH", triggerPrice: "1000",
  workingType: "MARK_PRICE", closePosition: "true", clientAlgoId: slId,
});
console.log("SL pre-entry:", sl.ok ? "DITERIMA" : `DITOLAK ${sl.status}`, sl.body.slice(0, 160));
if (sl.ok) out.placed.push(slId); else out.failures.push({ type: "SL", body: sl.body.slice(0, 200) });

// 2) TP: TAKE_PROFIT_MARKET closePosition=true, trigger absurd 999.999
const tp = await signed("POST", "/fapi/v1/algoOrder", {
  algoType: "CONDITIONAL", type: "TAKE_PROFIT_MARKET", symbol: "BTCUSDT",
  side: "SELL", positionSide: "BOTH", triggerPrice: "999999",
  workingType: "MARK_PRICE", closePosition: "true", clientAlgoId: tpId,
});
console.log("TP pre-entry:", tp.ok ? "DITERIMA" : `DITOLAK ${tp.status}`, tp.body.slice(0, 160));
if (tp.ok) out.placed.push(tpId); else out.failures.push({ type: "TP", body: tp.body.slice(0, 200) });

// 3) CANCEL semua yang berhasil dipasang
for (const id of out.placed) {
  const c = await signed("DELETE", "/fapi/v1/algoOrder", { clientAlgoId: id, symbol: "BTCUSDT" });
  console.log("CANCEL", id, c.ok ? "OK" : `GAGAL ${c.status}`, c.body.slice(0, 120));
}

// 4) Verifikasi: pastikan tidak ada sisa order probe di exchange
const open = await signed("GET", "/fapi/v1/openAlgoOrders", {});
const leftovers = open.ok ? (JSON.parse(open.body).orders ?? JSON.parse(open.body) ?? []) : [];
const probeLeft = (Array.isArray(leftovers) ? leftovers : []).filter((o) => String(o.clientAlgoId ?? "").startsWith("PROBE_"));
console.log("Sisa order probe di exchange:", probeLeft.length);
console.log(out.failures.length === 0 && probeLeft.length === 0
  ? "VERDICT: pre-entry bracket DIPERBOLEHKAN Binance (SL & TP closePosition tanpa posisi diterima)."
  : "VERDICT: lihat kegagalan di atas — perancangan perlu fallback.");
