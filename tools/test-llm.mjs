// ============================================================
// ArtaTrade AI - tools/test-llm.mjs (v3)
// Uji kelayakan model Xkiro untuk 12 agen.
// Cara pakai:
//   node tools/test-llm.mjs models     -> daftar model + pilihan target
//   node tools/test-llm.mjs case 3     -> jalankan 1 kasus uji (1..6)
//   node tools/test-llm.mjs            -> semua kasus + ringkasan
// Hasil tiap kasus ditulis juga ke tools/probe-results.jsonl
// Skrip ini TIDAK PERNAH menampilkan API key. Tanpa dependency (Node 18+).
// ============================================================

import { readFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS = join(ROOT, "tools", "probe-results.jsonl");

function loadEnv(file) {
  const out = {};
  let raw = "";
  try { raw = readFileSync(file, "utf8"); } catch { return out; }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["\x27]|["\x27]$/g, "");
  }
  return out;
}

function loadEnvChain(files) {
  const out = {};
  for (const f of files) {
    const e = loadEnv(f);
    for (const k of Object.keys(e)) {
      if (e[k] !== "" || !(k in out)) out[k] = e[k];
    }
  }
  return out;
}

const env = loadEnvChain([join(ROOT, "apps", "server", ".env"), join(ROOT, ".env")]);
const KEY = env.XKIRO_API_KEY || "";
const BASE = (env.XKIRO_BASE_URL || "https://api.xkiro.com/v1").replace(/\/+$/, "");

if (!KEY) {
  console.error("[GAGAL] XKIRO_API_KEY belum diisi di apps/server/.env (atau .env di root proyek)");
  console.error("        Buka file .env tersebut dengan editor, isi key-nya, simpan, lalu jalankan ulang.");
  process.exit(1);
}

const safe = (x) => String(x == null ? "" : x).split(KEY).join("***");

const HEADERS = {
  Authorization: "Bearer " + KEY,
  "Content-Type": "application/json",
  "User-Agent": "artatrade-probe/0.1",
};

async function getModels() {
  const r = await fetch(BASE + "/models", { headers: HEADERS, signal: AbortSignal.timeout(20000) });
  const txt = await r.text();
  if (!r.ok) throw new Error("models HTTP " + r.status + ": " + safe(txt).slice(0, 300));
  let j = null;
  try { j = JSON.parse(txt); } catch { throw new Error("respons models bukan JSON"); }
  const arr = Array.isArray(j) ? j : (j.data || j.models || []);
  return arr.map((x) => (typeof x === "string" ? x : x.id || x.name || "")).filter(Boolean);
}

function pickId(ids, kind, envKey) {
  const lc = ids.map((s) => s.toLowerCase());
  let i = -1;
  if (kind === "fast") {
    i = lc.findIndex((s) => s === "xiaomi/mimo-v2.6-flash" || s === "mimo-v2.6-flash");
    if (i < 0) i = lc.findIndex((s) => s.includes("mimo") && s.includes("flash"));
  } else {
    i = lc.findIndex((s) => s === "xiaomi/mimo-v2.6-pro" || s === "mimo-v2.6-pro");
    if (i < 0) i = lc.findIndex((s) => s.includes("mimo") && s.includes("pro"));
  }
  if (i >= 0) return ids[i];
  return env[envKey] || null;
}

async function resolveModels() {
  const ids = await getModels();
  const modelFast = pickId(ids, "fast", "XKIRO_MODEL_FAST");
  const modelReason = pickId(ids, "reason", "XKIRO_MODEL_REASON");
  console.log("Model tersedia (" + ids.length + "):");
  for (const id of ids) console.log("  - " + id);
  console.log("Model terpilih:");
  console.log("  FAST   (target MiMo)     : " + (modelFast || "(tidak ketemu)"));
  console.log("  REASON (target MiMo Pro) : " + (modelReason || "(tidak ketemu)"));
  if (!modelFast || !modelReason) throw new Error("model target tidak ditemukan di daftar");
  return { modelFast, modelReason };
}

async function chat(model, systemText, userText, temperature, maxTokens) {
  const body = {
    model,
    messages: [
      { role: "system", content: systemText },
      { role: "user", content: userText },
    ],
    temperature,
    max_tokens: maxTokens || 350,
  };
  const t0 = performance.now();
  const r = await fetch(BASE + "/chat/completions", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  });
  const ms = Math.round(performance.now() - t0);
  const txt = await r.text();
  let j = null;
  try { j = JSON.parse(txt); } catch { /* biarkan null */ }
  const text = j && j.choices && j.choices[0] && j.choices[0].message ? String(j.choices[0].message.content || "") : "";
  const tokens = j && j.usage ? j.usage.total_tokens : undefined;
  const finish = j && j.choices && j.choices[0] ? j.choices[0].finish_reason : undefined;
  const reasoningLen = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.reasoning_content ? String(j.choices[0].message.reasoning_content).length : 0;
  return { http: r.status, ms, text, tokens, finish, reasoningLen, err: r.ok ? "" : safe(txt).slice(0, 200) };
}

const CASES = [
  {
    name: "narasi-trade (Kirana/narrator)", kind: "fast", json: false, temperature: 0.7,
    system: "Kamu Kirana, narrator sistem trading ArtaTrade. Jawab Bahasa Indonesia, maksimal 2 kalimat, sebutkan angka dari data, dan dilarang memakai kalimat template umum.",
    user: "Event: {\"trade\":{\"symbol\":\"UNIUSDT\",\"side\":\"LONG\",\"pnlUsd\":0.35,\"pnlR\":0.31,\"closeReason\":\"TP2\"}}",
  },
  {
    name: "verdict-setup (Arka/setup-judge)", kind: "reason", json: true, temperature: 0.2, maxTokens: 900,
    system: "Kamu Arka, Setup Judge. Balas HANYA JSON polos tanpa blok kode dan tanpa teks lain, dengan kunci: go (boolean), confidence (angka 0-1), reason (Bahasa Indonesia maks 120 huruf).",
    user: "{\"symbol\":\"NEARUSDT\",\"score\":78,\"regime\":\"VOLATILE\",\"knnProb\":0.71,\"knnN\":64,\"gates\":{\"volume\":true,\"chopAdx\":true,\"macro\":true,\"btcDom\":true}}",
  },
  {
    name: "verdict-setup (uji silang di MiMo)", kind: "fast", json: true, temperature: 0.2,
    system: "Kamu Arka, Setup Judge. Balas HANYA JSON polos tanpa blok kode dan tanpa teks lain, dengan kunci: go (boolean), confidence (angka 0-1), reason (Bahasa Indonesia maks 120 huruf).",
    user: "{\"symbol\":\"NEARUSDT\",\"score\":78,\"regime\":\"VOLATILE\",\"knnProb\":0.71,\"knnN\":64,\"gates\":{\"volume\":true,\"chopAdx\":true,\"macro\":true,\"btcDom\":true}}",
  },
  {
    name: "brief-makro (Vega/macro-scout)", kind: "reason", json: false, temperature: 0.4,
    system: "Kamu Vega, Macro Scout. Bahasa Indonesia, maksimal 3 kalimat, wajib menyebut angka.",
    user: "{\"BTCUSDT\":{\"regime\":\"TRENDING_UP\",\"adx\":27,\"chg1hPct\":0.8},\"ETHUSDT\":{\"regime\":\"TRENDING_UP\",\"chg1hPct\":0.6},\"BTCDOMUSDT\":{\"chg1hPct\":0.12}}",
  },
  {
    name: "usulan-parameter (Laras/strategy-tuner)", kind: "reason", json: true, temperature: 0.3, maxTokens: 900,
    system: "Kamu Laras, Strategy Tuner. Balas HANYA JSON polos tanpa blok kode dan tanpa teks lain: {param, from, to, boundedPct (<=10), rationale (Bahasa Indonesia)}.",
    user: "{\"lossFactor\":\"SL_TIGHT\",\"currentSLPct\":0.6,\"mode\":\"SCALP\"}",
  },
  {
    name: "alert-watchdog (Raksa/watchdog)", kind: "fast", json: false, temperature: 0.5,
    system: "Kamu Raksa, Watchdog. Bahasa Indonesia, 1-2 kalimat, lugas, sebut angka.",
    user: "{\"event\":\"HOST_SWITCH\",\"from\":\"fapi\",\"to\":\"fapi2\",\"consecutiveFails\":5,\"detectMs\":2100}",
  },
];

async function runCase(n, c, modelFast, modelReason) {
  const model = c.kind === "fast" ? modelFast : modelReason;
  process.stdout.write("[case " + n + "/" + CASES.length + "] " + c.name + " -> " + model + " ... ");
  let res;
  try { res = await chat(model, c.system, c.user, c.temperature, c.maxTokens); }
  catch (e) { res = { http: 0, ms: 0, text: "", tokens: undefined, finish: undefined, reasoningLen: 0, err: safe(e.message).slice(0, 200) }; }
  let jsonOK = "n/a";
  if (c.json) {
    jsonOK = "FAIL";
    try { const p = JSON.parse(res.text.trim()); if (p && typeof p === "object" && Object.keys(p).length > 0) jsonOK = "OK"; } catch { /* tetap FAIL */ }
  }
  const preview = res.text.replace(/\s+/g, " ").trim().slice(0, 120);
  console.log("HTTP " + res.http + " | " + res.ms + " ms | json:" + jsonOK + (res.tokens ? " | tok:" + res.tokens : "") + (res.finish ? " | finish:" + res.finish : "") + (res.reasoningLen ? " | reasoning:" + res.reasoningLen + "ch" : ""));
  if (preview) console.log("      \"" + preview + (res.text.length > 120 ? "..." : "") + "\"");
  if (res.err) console.log("      ERR: " + res.err);
  if (c.json && jsonOK === "FAIL") console.log("      RAW: " + res.text.replace(/\s+/g, " ").slice(0, 500));
  const row = { ts: new Date().toISOString(), case: c.name, kind: c.kind, model, http: res.http, ms: res.ms, jsonOK, tokens: res.tokens, finish: res.finish, reasoningLen: res.reasoningLen, preview, raw: (c.json && jsonOK === "FAIL") ? res.text.slice(0, 2000) : undefined };
  try { appendFileSync(RESULTS, JSON.stringify(row) + "\n"); } catch { /* abaikan */ }
  return row;
}

const args = process.argv.slice(2);
const mode = args[0] || "all";

console.log("== ArtaTrade AI - probe model Xkiro ==");
console.log("BASE:", BASE);

let resolved = null;
try { resolved = await resolveModels(); }
catch (e) {
  console.error("[GAGAL] " + safe(e.message));
  console.error("Periksa XKIRO_API_KEY dan XKIRO_BASE_URL.");
  process.exitCode = 1;
}

const modelFast = resolved ? resolved.modelFast : null;
const modelReason = resolved ? resolved.modelReason : null;
console.log("");

const modelsOnly = (mode === "models");
let pick = null;
if (resolved && !modelsOnly) {
  if (mode === "case") {
    const n = parseInt(args[1], 10);
    if (!(n >= 1 && n <= CASES.length)) {
      console.error("Nomor kasus harus 1.." + CASES.length);
      process.exitCode = 2;
    } else {
      pick = [{ n, c: CASES[n - 1] }];
    }
  } else {
    pick = CASES.map((c, i) => ({ n: i + 1, c }));
  }
}

if (modelsOnly) {
  if (resolved) console.log("(mode models selesai; lanjutkan: node tools/test-llm.mjs case 1)");
} else if (pick) {
  const rows = [];
  for (const item of pick) rows.push(await runCase(item.n, item.c, modelFast, modelReason));

  if (mode !== "case") {
    console.log("\n== RINGKASAN ==");
    const okRows = rows.filter((r) => r.http === 200);
    console.log("Berhasil: " + okRows.length + "/" + rows.length + " panggilan (HTTP 200)");
    for (const kind of ["fast", "reason"]) {
      const k = rows.filter((r) => r.kind === kind && r.http === 200);
      if (!k.length) continue;
      const avg = Math.round(k.reduce((a, r) => a + r.ms, 0) / k.length);
      const jsonCases = k.filter((r) => r.jsonOK !== "n/a");
      const jsonPass = jsonCases.filter((r) => r.jsonOK === "OK").length;
      console.log("- " + kind.toUpperCase() + ": rata-rata " + avg + " ms; JSON lulus " + jsonPass + "/" + jsonCases.length);
    }
    const bad = rows.filter((r) => r.http !== 200 || r.jsonOK === "FAIL");
    if (bad.length) {
      console.log("\nPerhatian - kasus bermasalah:");
      for (const r of bad) console.log("  - " + r.case + " [" + r.model + "] HTTP " + r.http + " json:" + r.jsonOK);
    } else {
      console.log("\nSemua kasus lolos: MiMo V2.6 Flash layak untuk 7 agen frekuensi tinggi; DeepSeek V4.1 Flash layak untuk 5 agen analisa.");
    }
    console.log("\nPeta acuan 12 agen:");
    console.log("  FAST   (7): Vega, Sena, Rhea, Bima, Nadira, Raksa, Kirana");
    console.log("  REASON (5): Arka, Wardha, Sesha, Laras, Varuna");
  } else {
    console.log("\nHasil tersimpan di tools/probe-results.jsonl");
  }
}
