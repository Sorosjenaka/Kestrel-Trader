#!/usr/bin/env node
// tools/test-drex.mjs — DRY RUN aman lapisan keputusan Drex (NaceAI).
// - TIDAK menyentuh Binance / eksekusi order apa pun (murni 1 panggilan API Drex).
// - DREX_API_KEY diambil dari ENVIRONMENT saja (export / inline env).
// - Key TIDAK PERNAH dicetak; output = status HTTP, latensi, dan jawaban Drex.
//
// Pakai:  DREX_API_KEY=<key-anda> node tools/test-drex.mjs
// Tanpa key: script berhenti dengan status kunci (SET/MISSING) tanpa panggilan keluar.

const KEY = (process.env.DREX_API_KEY ?? "").trim();
const BASE = (process.env.DREX_BASE_URL ?? "https://drex.nace.ai").replace(/\/+$/, "");
const MODEL = process.env.DREX_MODEL ?? "drex-v1.5";
const TIMEOUT_MS = Number(process.env.DREX_TIMEOUT_MS ?? 4000);
const MIN_P = Number(process.env.DREX_MIN_ENTRY_PROBABILITY ?? 0.55);

const redact = (s) => (KEY ? s.split(KEY).join("[REDACTED]") : s);

if (!KEY) {
  console.log("DREX_API_KEY = MISSING — tidak ada panggilan keluar yang dilakukan.");
  console.log("Jalankan dengan: DREX_API_KEY=<key-anda> node tools/test-drex.mjs");
  console.log("(key tidak pernah dicetak; hanya status SET/MISSING yang tampil)");
  process.exit(2);
}
console.log("DREX_API_KEY = SET (nilai tidak ditampilkan)");

// State demo JELAS sintetis — bukan data bot, bukan data pasar nyata.
// Tujuan: memverifikasi kontrak request/response Drex tanpa jalur trading.
const DEMO_STATE = {
  schemaVersion: "artatrade-scalp-state-v1",
  note: "DRY RUN state sintetis — bukan data bot / bukan sinyal trading",
  symbol: "DEMOUSDT",
  side: "LONG",
  mode: "SCALP",
  timeframes: { trigger: "1m", confirm: "3m", structure: "5m", bias: "15m", macro: "1h" },
  scores: { zoneScore: 72, triggerScore: 65, compositeScore: 71, knnProb: 0.58, knnProbCalibrated: false, regime: "TRENDING" },
  strategy: { id: "S-03", rr: 1.5 },
  levels: { entryPrice: 64250, slPrice: 63610, tp1Price: 65210, slPct: 0.01 },
  marketContext: { volumeUsd: 24500000, fundingRate: 0.00012, structureAdx: 27.4, structureChop: 0.31, biasAdx: 31, biasChop: 0.22, structureAtrPct: 0.0042 },
  macro: { allowed: true, detail: "demo" },
  session: { paperMode: true, minScore: 70, minKnn: 0.55, emptySlots: 12, maxPositions: 20 },
};

const QUESTIONS = {
  entry_go: {
    type: "noul",
    instructions: "Based on the provided market state, should this setup be executed?",
    criteria: {
      true: "The setup has a positive expected edge right now given scores, regime, structure, macro and session context.",
      false: "The setup is late, crowded, contradicted by macro/structure, or low quality.",
    },
  },
  direction: {
    type: "choice",
    instructions: "Which position direction is better supported by the current market state?",
    criteria: {
      LONG: "Structure and liquidity favor upside over the next few minutes.",
      SHORT: "Structure and liquidity favor downside over the next few minutes.",
    },
  },
  setup_strength: {
    type: "score",
    instructions: "How strong is the current trading setup?",
    criteria: ["very_weak", "weak", "moderate", "strong", "very_strong"],
  },
};

const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), Math.max(1, TIMEOUT_MS));
const t0 = Date.now();
let res, text;
try {
  res = await fetch(`${BASE}/v1/systemone`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, state: DEMO_STATE, questions: QUESTIONS }),
    signal: ctrl.signal,
  });
  const t1 = Date.now();
  text = await res.text();
  const t2 = Date.now();
  console.log(`HTTP ${res.status}  requestMs=${t1 - t0}  responseMs=${t2 - t1}  totalMs=${t2 - t0}`);
} catch (err) {
  clearTimeout(timer);
  const aborted = err && err.name === "AbortError";
  console.log(redact(`GAGAL: ${aborted ? `timeout ${TIMEOUT_MS}ms` : String(err && err.message ? err.message : err)}`));
  process.exit(1);
}
clearTimeout(timer);

if (!res.ok) {
  console.log(redact(`Body error (dipotong): ${text.slice(0, 300)}`));
  console.log("Failover di bot: Drex gagal -> judge Xkiro -> fail-closed NO-GO.");
  process.exit(1);
}

let json;
try {
  json = JSON.parse(text);
} catch {
  console.log("Body bukan JSON valid — bot akan menandai DREX_MALFORMED_RESPONSE dan failover.");
  process.exit(1);
}
console.log(`model=${json.model ?? MODEL}  request_id=${json.request_id ?? "n/a"}  evaluation_time_ms=${json.evaluation_time_ms ?? "n/a"}`);
console.log("answers:");
console.log(redact(JSON.stringify(json.answers ?? {}, null, 2)));

// Preview pemetaan keputusan (sama persis dengan aturan di decisionRiskLayer):
const go = json.answers && json.answers.entry_go;
const p = go && typeof go === "object" ? (go.noul ?? go.probability ?? go.value) : null;
const dir = json.answers && json.answers.direction ? json.answers.direction.choice : null;
if (typeof p === "number") {
  const rulePass = p >= MIN_P && dir === DEMO_STATE.side;
  console.log(`preview rule: entry_go p=${p.toFixed(2)} vs ambang ${MIN_P}, direction=${dir} (plan ${DEMO_STATE.side}) -> ${rulePass ? "GO (jika gate deterministik lolos)" : "NO-GO"}`);
} else {
  console.log("preview rule: entry_go tidak berupa skalar 0..1 — bot akan menandai DREX_MALFORMED_RESPONSE.");
}
console.log("Selesai. Tidak ada order Binance yang terlibat dalam dry run ini.");
