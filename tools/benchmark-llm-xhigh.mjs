// Benchmark configured Xkiro reasoning models with identical prompts and xhigh.
// Reports model IDs, HTTP status and end-to-end latency only; never prints keys or responses.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
function parseEnv(file) {
  const result = {};
  let raw = "";
  try { raw = readFileSync(file, "utf8"); } catch { return result; }
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match) result[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return result;
}

const env = { ...parseEnv(join(ROOT, ".env")), ...parseEnv(join(ROOT, "apps", "server", ".env")) };
// A blank per-app key must fall through to the root key.
if (!env.XKIRO_API_KEY) env.XKIRO_API_KEY = parseEnv(join(ROOT, ".env")).XKIRO_API_KEY || "";
const key = env.XKIRO_API_KEY || "";
const base = (env.XKIRO_BASE_URL || "https://api.xkiro.com/v1").replace(/\/+$/, "");
const primary = env.XKIRO_MODEL_REASON || "xiaomi/mimo-v2.6-pro";
const fallbacks = (env.XKIRO_MODEL_REASON_FALLBACKS || "")
  .split(",").map((model) => model.trim()).filter(Boolean);
const models = [...new Set([primary, ...fallbacks])];
const trials = 3;

if (!key) {
  console.error("XKIRO_API_KEY tidak ditemukan; probe berhenti tanpa menampilkan konfigurasi rahasia.");
  process.exit(1);
}

const rows = [];
for (const model of models) {
  for (let trial = 1; trial <= trials; trial += 1) {
    const started = performance.now();
    let status = 0;
    let actualModel = "";
    let outputChars = 0;
    let error = "";
    try {
      const response = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "User-Agent": "artatrade-xhigh-latency-benchmark/1.0",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: "You are a concise quantitative analyst. Return a short, evidence-based answer." },
            { role: "user", content: "In one sentence, explain why a trend-following setup should be skipped when trend evidence conflicts across timeframes." },
          ],
          temperature: 0.1,
          max_tokens: 128,
          reasoning_effort: "xhigh",
        }),
        signal: AbortSignal.timeout(60_000),
      });
      status = response.status;
      const payload = response.ok ? await response.json() : null;
      const answer = payload?.choices?.[0]?.message?.content;
      actualModel = payload?.model || "";
      outputChars = typeof answer === "string" ? answer.length : 0;
      if (!response.ok) error = `HTTP_${response.status}`;
      else if (!outputChars) error = "EMPTY_RESPONSE";
    } catch (cause) {
      error = cause?.name === "TimeoutError" || cause?.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR";
    }
    const ms = Math.round(performance.now() - started);
    rows.push({ model, trial, status, ms, actualModel, outputChars, error });
    console.log(`${model} | run ${trial}/${trials} | HTTP ${status || "-"} | ${ms} ms${actualModel ? ` | answered=${actualModel}` : ""}${error ? ` | ${error}` : ""}`);
  }
}

console.log("\nRINGKASAN LATENSI xhigh (end-to-end, termasuk reasoning dan pembuatan jawaban):");
for (const model of models) {
  const valid = rows.filter((row) => row.model === model && row.status === 200 && row.outputChars > 0).map((row) => row.ms).sort((a, b) => a - b);
  if (!valid.length) {
    console.log(`${model} | tidak ada respons sukses untuk dihitung`);
    continue;
  }
  const median = valid[Math.floor(valid.length / 2)];
  const avg = Math.round(valid.reduce((sum, ms) => sum + ms, 0) / valid.length);
  console.log(`${model} | sukses ${valid.length}/${trials} | median ${median} ms | rata-rata ${avg} ms`);
}
