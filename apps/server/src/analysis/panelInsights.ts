// apps/server/src/analysis/panelInsights.ts — 26 Okt 2026 (TAHAP 6B)
//
// Analisis AI lima panel mikrostruktur: dipanggil otomatis, tersimpan, terlihat.
//
// Kontrak TAHAP 6B:
//  - SEMUA angka dihitung kode dari hub live; LLM HANYA menafsirkan.
//  - Prompt per panel memakai BRIEF TERSTRUKTUR (angka/sumber/waktu/dukungan/
//    konflik/hilang) — bukan dump JSON mentah yang panjang.
//  - BUDGET PANEL = batas keras: diperiksa SEBELUM tiap request (termasuk
//    retry) sehingga tidak ada overshoot antar-batch. Metrik attempt, success,
//    cache hit, dan token aktual dicatat terpisah.
//  - Freshness mengikuti WAKTU EVIDENCE SUMBER, bukan generatedAt/TTL cache.
//    Evidence yang basi ditandai STALE dan TIDAK dipakai untuk analisis baru.
//  - Antrean: panel memakai kelas "low" (narasi) + fairnessKey per simbol,
//    sehingga panel lambat tidak menahan judge/supervisi dan BTC tidak
//    mengambil seluruh antrean.
//  - Fallback deterministik SELALU berlabel FALLBACK (bukan hasil LLM).

import { createHash } from "node:crypto";
import { db } from "../core/db.js";
import { env } from "../core/env.js";
import { logger } from "../core/logger.js";
import { defaultLlmAdapter, LlmBudgetExceededError, LlmEvidenceStaleError, LlmLocalAbort, type LlmCallOptions, type LlmResponse } from "../agents/llmAdapter.js";
import {
  gatherPanelEvidence, PANEL_AI_SCHEMA_VERSION, PANEL_EVIDENCE_MAX_AGE_MS, PANEL_IDS,
  type PanelEvidence, type PanelId,
} from "./panelEvidence.js";
import { buildCombinedBrief, buildPanelBrief, renderBrief } from "./panelBrief.js";
import type { PanelBrief } from "./panelEvidence.js";
import { PanelBudget } from "./panelBudget.js";

export const PANEL_AI_EVENT_TYPE = "PANEL_AI_ANALYSIS";

export type PanelAiStatus = "LLM_SUCCESS" | "FALLBACK" | "STALE" | "UNAVAILABLE" | "BUDGET_EXHAUSTED";

export { PANEL_AI_SCHEMA_VERSION, PANEL_IDS, PANEL_EVIDENCE_MAX_AGE_MS };
export type { PanelEvidence, PanelId };

export interface PanelAiRow {
  panel: PanelId;
  symbol: string;
  status: PanelAiStatus;
  model: string | null;
  text: string;
  evidenceSnapshotId: string;
  evidenceHash: string;
  generatedAt: string;
  /** Durasi total (antrean + provider) untuk baris ini. */
  latencyMs: number | null;
  /** TAHAP 6B — durasi provider saja (ms), TANPA antrean. */
  providerMs: number | null;
  /** TAHAP 6B — antrean: waktu trigger diterima sampai slot provider didapat (ms). */
  queueWaitMs: number | null;
  /** TAHAP 6B — jumlah attempt HTTP (termasuk retry). */
  attempts: number | null;
  /** TAHAP 6B — finish_reason dari provider. */
  finishReason: string | null;
  /** TAHAP 6B — token aktual dari provider (bukan estimasi). */
  tokens: number | null;
  /** TAHAP 6B — promptTokens / completionTokens terpisah. */
  promptTokens: number | null;
  completionTokens: number | null;
  /** TAHAP 6B — umur evidence sumber TERLAMA saat analisis dibuat (ms). */
  evidenceAgeMs: number | null;
  /** TAHAP 6B — status freshness per panel (evidence sumber). */
  evidenceFreshness: "fresh" | "stale" | "unknown";
  /** TAHAP 6B — kode kegagalan terstruktur (null bila sukses). */
  errorCode: string | null;
}

/**
 * Metrik agregat runtime (TAHAP 6B). PEMISAHAN PENTING:
 *  - `attempts` = jumlah request HTTP yang dikirim (termasuk retry).
 *  - `success` = jumlah baris LLM_SUCCESS.
 *  - `cacheHit` = analisis yang DILEWATI karena bukti tak berubah / budget.
 *  - `tokens` = token aktual dari provider.
 * Metrik ini KHUSUS panel AI — tidak dicampur dengan metrik agen global.
 */
export const panelAiStats = {
  runs: 0,
  skippedUnchanged: 0,
  skippedStale: 0,
  budgetExhausted: 0,
  llmSuccess: 0,
  fallback: 0,
  unavailable: 0,
  /** Total request HTTP yang dikirim ke provider (termasuk retry 429/5xx). */
  attempts: 0,
  /** Jumlah baris analisis yang memakai token provider. */
  success: 0,
  /** Analisis yang dilewati (dedup / stale / budget) — TIDAK menambah token. */
  cacheHit: 0,
  tokens: 0,
  promptTokens: 0,
  completionTokens: 0,
  queueWaitMsTotal: 0,
  providerMsTotal: 0,
  lastRunAt: 0,
  /** Jumlah batch yang gagal MEMASUKI budget (guard sebelum request). */
  budgetBlockedBeforeSend: 0,
  /** TAHAP 6C: respons terpotong (finishReason "length") yang dipulihkan
   *  oleh satu retry terukur (effort lebih rendah + budget lebih besar). */
  truncationRetries: 0,
};

export const PANEL_SYSTEM_PROMPTS: Record<PanelId, string> = {
  orderflow: [
    "Anda adalah analis order flow kripto. Tugas per TAHAP 4B:",
    "bandingkan delta/CVD dengan perubahan harga; pisahkan spot dan perpetual;",
    "bandingkan horizon yang tersedia (15m/1h/session); jelaskan pertentangan antar-horizon",
    "dan antar-venue bila ada. JANGAN mengambil kesimpulan dari total CVD saja.",
    "Semua angka sudah diberikan — jangan menghitung ulang, jangan mengarang angka.",
    "Maksimal 8 baris, bahasa Indonesia, berbasis bukti.",
  ].join(" "),
  walls: [
    "Anda adalah analis likuiditas order book. Baca sisi BID/ASK, nilai, jarak harga,",
    "umur, dan perubahan wall dari data lifecycle (APPEARED/MOVED/PULLED/EATEN).",
    "Jelaskan persistensi likuiditas dan keterbatasan klasifikasinya. JANGAN menyatakan",
    "wall yang dibatalkan pasti spoofing atau pasti tereksekusi. Semua angka sudah",
    "diberikan. Maksimal 8 baris, bahasa Indonesia.",
  ].join(" "),
  liqmap: [
    "Anda adalah analis peta likuidasi. Jelaskan cluster atas/bawah, jarak dari mark,",
    "konsentrasi, sumber data, dan coverage. Bedakan 'cluster tidak ditemukan' dari",
    "'data tidak tersedia'. Jelaskan keterbatasan sampling. JANGAN menyebut magnet",
    "sebagai kepastian arah harga. Semua angka sudah diberikan. Maksimal 8 baris.",
  ].join(" "),
  largetrades_vp: [
    "Anda adalah analis transaksi besar + volume profile. Baca BUY/SELL sesuai definisi",
    "aggressor venue (bukan menebak niat pelaku). Kaitkan transaksi besar dengan harga,",
    "POC, VAH, VAL; jelaskan posisi harga terhadap value area dan distribusi volume.",
    "JANGAN menyimpulkan niat pelaku dari satu transaksi. Semua angka sudah diberikan.",
    "Maksimal 8 baris, bahasa Indonesia.",
  ].join(" "),
  tierflow: [
    "Anda adalah analis tier & flow. Baca kontribusi setiap tier (MEGA/WHALE/MEDIUM/SMALL)",
    "dan per exchange; jelaskan perbedaan arus tier besar vs kecil; tunjukkan dominasi",
    "agregat oleh tier/venue tertentu. Tier ukuran transaksi BUKAN bukti identitas whale",
    "atau wallet. Semua angka sudah diberikan. Maksimal 8 baris, bahasa Indonesia.",
  ].join(" "),
  combined: [
    "Anda adalah analis mikrostruktur gabungan. Input sudah berupa BRIEF TERSTRUKTUR",
    "lima panel (angka/sumber/waktu/dukungan/konflik/hilang). Tugas Anda:",
    "1) tulis fakta pendukung thesis; 2) tulis fakta penentang; 3) kondisi campuran;",
    "4) data hilang atau kedaluwarsa (WAJIB disebut bila ada); 5) horizon yang dipakai;",
    "6) kondisi invalidasi; 7) masa berlaku analisis.",
    "Jangan mengulang angka mentah. Jangan membandingkan total kumulatif dengan delta",
    "rolling seolah sama. Jika ada konflik antar panel, nyatakan konflik itu, jangan",
    "ratakan menjadi satu arah. Jika evidence basi, kesimpulan WAJIB ditandai basa.",
    "Maksimal 12 baris, bahasa Indonesia, berbasis bukti.",
  ].join(" "),
};

// ── State runtime: dedup, budget, concurrency ──────────────────────────────
const lastRun = new Map<string, { hash: string; at: number }>();
let chain: Promise<void> = Promise.resolve();

/** Budget PANEL (batas keras) — terpisah dari budget agen global. */
let panelBudget: PanelBudget | null = null;
let panelBudgetKey = "";

function getPanelBudget(): PanelBudget {
  const cfg = {
    maxRequestsPerHour: env.PANEL_AI_MAX_PER_HOUR,
    maxTokensPerHour: env.PANEL_AI_MAX_TOKENS_PER_HOUR,
    maxRequestsPerBatch: env.PANEL_AI_MAX_REQUESTS_PER_BATCH,
  };
  const key = JSON.stringify(cfg);
  if (!panelBudget || panelBudgetKey !== key) {
    panelBudget = new PanelBudget(cfg);
    panelBudgetKey = key;
  }
  return panelBudget;
}

/** Hash inti numerik bukti — deduplikasi antar-trigger (perubahan material saja). */
export function evidenceHash(evidences: PanelEvidence[]): string {
  const core = evidences.map((e) => [e.panel, e.status,
    JSON.stringify(e.data).length > 4096 ? JSON.stringify(e.data).slice(0, 4096) : JSON.stringify(e.data)]);
  return createHash("sha256").update(JSON.stringify(core)).digest("hex").slice(0, 16);
}

/** Fallback deterministik — SELALU berlabel, tidak pernah mengarang opinion. */
function fallbackText(panel: PanelId, briefs: PanelBrief[]): string {
  const head = "Ringkasan deterministik (FALLBACK — bukan hasil LLM):";
  if (panel === "combined") {
    const rows = briefs.map((b) => `- ${b.panel} [${b.status}] ${b.figures.slice(0, 2).join(" | ") || "tidak ada angka"}`);
    return `${head}\n${rows.join("\n")}`;
  }
  const b = briefs.find((x) => x.panel === panel);
  if (!b) return `${head} data panel tidak tersedia.`;
  return `${head} ${b.figures.join(" | ") || "data panel tidak tersedia."}`;
}

/** Simpan baris analisis (anti-overwrite: hasil lebih lama tidak menimpa lebih baru). */
async function storeAnalysis(row: PanelAiRow): Promise<void> {
  const latest = await db.eventLog.findFirst({
    where: { type: PANEL_AI_EVENT_TYPE }, orderBy: { id: "desc" }, take: 30, select: { payload: true },
  }).catch(() => null);
  if (latest) {
    try {
      const p = JSON.parse(latest.payload) as { panel?: string; symbol?: string; generatedAt?: string };
      if (p.panel === row.panel && p.symbol === row.symbol && p.generatedAt && p.generatedAt > row.generatedAt) return;
    } catch { /* payload lain — lanjut simpan */ }
  }
  await db.eventLog.create({ data: { type: PANEL_AI_EVENT_TYPE, severity: "info", payload: JSON.stringify(row) } })
    .catch((err) => logger.warn({ err: (err as Error).message, panel: row.panel }, "PANEL_AI_STORE_FAILED"));
}

/** Freshness evidence: "fresh" | "stale" | "unknown" (berdasar waktu SUMBER). */
function evidenceFreshness(evidences: PanelEvidence[], now: number): "fresh" | "stale" | "unknown" {
  const ages = evidences.map((e) => e.ageMs).filter((a): a is number => a != null);
  if (ages.length === 0) return "unknown";
  const oldest = Math.max(...ages);
  if (oldest > PANEL_EVIDENCE_MAX_AGE_MS) return "stale";
  return "fresh";
}

/**
 * Analisis satu panel.
 *
 * TAHAP 6B:
 *  - Prompt memakai BRIEF terstruktur (bukan dump JSON mentah).
 *  - Budget keras diperiksa SEBELUM request (guard) dan lagi saat antre
 *    (recheck freshness) — evidence yang basi dibatalkan, bukan dianalisis
 *    dengan data lama.
 *  - Metrik dipisah: queueWaitMs (antrean), providerMs (provider),
 *    attempts (request HTTP), tokens (aktual dari provider), finishReason.
 */
/**
 * TAHAP 6C (26 Okt 2026) — opsi panggilan LLM per panel, dari HASIL UKUR,
 * bukan dugaan (probe t6c-isolate: prompt combined identik produksi, 5 panel
 * fresh, n=6 request terisolasi + 2 pengukuran produksi):
 *  - TRUNCATED (finishReason "length") saat maxTokens 1200 + effort high/xhigh:
 *    token reasoning menghabiskan budget output (E1 xhigh & E4 high gagal pada
 *    1200t; E3 medium 1008 tok sukses; E2 xhigh 2200t sukses dgn 1684 tok).
 *    => akar masalah BUKAN "maxTokens kecil" saja, melainkan budget output
 *    tidak menyisakan headroom reasoning pada effort tinggi.
 *  - LLM_TIMEOUT pada providerMs 25001 = batas default provider, dengan
 *    queueWaitMs 0 (BUKAN antrean). Durasi wajar combined 19–30 dtk.
 *  - Maka combined: effort medium (terukur cukup utk 12 baris), budget output
 *    + headroom reasoning 2400, dan timeout khusus 45 dtk — ketiganya terukur,
 *    bukan sekadar memperbesar timeout. Budget token/jam tetap memakai TOKEN
 *    AKTUAL (budgetGuard), jadi kenaikan maxTokens tidak mengurangi batas keras.
 */
export function panelLlmCallOptions(
  panel: PanelId,
): Pick<LlmCallOptions, "maxTokens" | "timeoutMs" | "reasoningEffort"> {
  if (panel === "combined") {
    return { maxTokens: 2400, timeoutMs: 45_000, reasoningEffort: "medium" };
  }
  // Panel tunggal: prompt jauh lebih pendek; konfigurasi produksi terbukti
  // konsisten stop tanpa truncation. timeoutMs eksplisit = default provider.
  return { maxTokens: 1200, timeoutMs: 25_000 };
}

/**
 * TAHAP 6C — opsi SATU retry saat respons terpotong (finishReason "length").
 * Terukur: pemakaian token reasoning BEREKOR BERAT pada effort yang sama
 * (combined medium: 1176 tok sukses vs >2400 tok terpotong pada prompt yang
 * sama). Budget statis tidak bisa deterministik menutup ekor ini, maka satu
 * retry dengan effort LEBIH RENDAH (memotong token reasoning) + budget lebih
 * besar (menutup sisa ekor). Bukan "sekadar memperbesar maxTokens": retry
 * hanya terjadi bila truncation benar-benar terjadi, dan tetap dihitung ke
 * budget keras (guard menambah attempt per request HTTP).
 */
export function panelLlmTruncationRetryOptions(
  panel: PanelId,
): Pick<LlmCallOptions, "maxTokens" | "timeoutMs" | "reasoningEffort"> {
  if (panel === "combined") {
    return { maxTokens: 4000, timeoutMs: 45_000, reasoningEffort: "low" };
  }
  return { maxTokens: 2400, timeoutMs: 30_000, reasoningEffort: "low" };
}

export interface PanelLlmCallResult {
  res: LlmResponse;
  /** true = pulih lewat retry truncation (respons pertama terpotong). */
  usedTruncationRetry: boolean;
  /** Total request HTTP terkirim (termasuk attempt yang terpotong + retry). */
  attempts: number;
}

/**
 * Panggil LLM panel dengan SATU retry truncation. Error lain (timeout, HTTP,
 * budget, evidence basi) DITERUSKAN apa adanya — hanya truncation yang punya
 * jalur pemulihan, karena hanya itu yang akar masalahnya terukur.
 */
export async function callPanelWithTruncationRetry(
  panel: PanelId,
  invoke: (options: Pick<LlmCallOptions, "maxTokens" | "timeoutMs" | "reasoningEffort">) => Promise<LlmResponse>,
): Promise<PanelLlmCallResult> {
  try {
    const res = await invoke(panelLlmCallOptions(panel));
    return { res, usedTruncationRetry: false, attempts: res.attempts ?? 1 };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "LLM_TRUNCATED_RESPONSE") throw err;
    const firstAttempts = (err as { attempts?: number | null }).attempts ?? 1;
    logger.warn(
      { panel, err: (err as Error).message, attempts: firstAttempts },
      "PANEL_AI_TRUNCATED_RETRY",
    );
    const res = await invoke(panelLlmTruncationRetryOptions(panel));
    return { res, usedTruncationRetry: true, attempts: firstAttempts + (res.attempts ?? 1) };
  }
}

async function analyzePanel(opts: {
  panel: PanelId;
  symbol: string;
  evidences: PanelEvidence[];
  hash: string;
  queueWaitMs: number | null;
  batchIndex: number;
  /** Paksa analisis meski evidence basi (hanya untuk probe manual operator). */
  force?: boolean;
}): Promise<void> {
  const { panel, symbol, evidences, hash } = opts;
  const ev = panel === "combined" ? null : evidences.find((e) => e.panel === panel);
  const budget = getPanelBudget();

  // Panel tunggal yang evidence-nya tidak tersedia: LLM tidak dipanggil.
  if (ev && ev.status === "unavailable") {
    panelAiStats.unavailable += 1;
    budget.recordCacheHit();
    await storeAnalysis({
      panel, symbol, status: "UNAVAILABLE", model: null,
      text: "Evidence panel unavailable — LLM tidak dipanggil (jujur, tanpa fabrikasi).",
      evidenceSnapshotId: ev.snapshotId, evidenceHash: hash,
      generatedAt: new Date().toISOString(), latencyMs: null,
      providerMs: null, queueWaitMs: opts.queueWaitMs, attempts: 0, finishReason: null,
      tokens: null, promptTokens: null, completionTokens: null,
      evidenceAgeMs: ev.ageMs, evidenceFreshness: "unknown", errorCode: null,
    });
    return;
  }

  // ── Freshness recheck: evidence dihitung SEBELUM antre; kalau sudah basi
  //    saat giliran tiba, jangan kirim request LLM untuk data basi.
  const now = Date.now();
  const freshness = evidenceFreshness(evidences, now);
  const oldestAge = Math.max(0, ...evidences.map((e) => e.ageMs ?? 0));
  if (freshness === "stale" && !opts.force) {
    panelAiStats.skippedStale += 1;
    budget.recordCacheHit();
    await storeAnalysis({
      panel, symbol, status: "STALE", model: null,
      text: `Evidence basi (umur sumber ${Math.round(oldestAge / 1000)}dtk > ${Math.round(PANEL_EVIDENCE_MAX_AGE_MS / 1000)}dtk) — LLM tidak dipanggil agar tidak menganalisis data lama.`,
      evidenceSnapshotId: ev?.snapshotId ?? evidences.map((e) => e.snapshotId).join(","),
      evidenceHash: hash, generatedAt: new Date().toISOString(), latencyMs: null,
      providerMs: null, queueWaitMs: opts.queueWaitMs, attempts: 0, finishReason: null,
      tokens: null, promptTokens: null, completionTokens: null,
      evidenceAgeMs: oldestAge, evidenceFreshness: "stale", errorCode: "EVIDENCE_STALE",
    });
    logger.info({ panel, symbol, oldestAgeMs: oldestAge }, "PANEL_AI_SKIPPED_STALE");
    return;
  }

  const briefs = panel === "combined"
    ? buildCombinedBrief(evidences, now).briefs
    : [buildPanelBrief(ev!, now)];
  const combinedMeta = panel === "combined" ? buildCombinedBrief(evidences, now) : null;

  // Prompt RINGKAS: brief terstruktur, bukan narasi/JSON mentah panjang.
  const promptParts: string[] = [
    `Simbol: ${symbol}. Semua angka di bawah sudah dihitung kode dari data live — jangan menghitung ulang, jangan mengarang.`,
    `Waktu evidence sumber (epoch ms): ${evidences.map((e) => `${e.panel}=${e.sourceTsMs ?? "?"}`).join(", ")}`,
    `Umur evidence: ${Math.round(oldestAge / 1000)}dtk (batas ${Math.round(PANEL_EVIDENCE_MAX_AGE_MS / 1000)}dtk).`,
  ];
  if (panel === "combined") {
    promptParts.push("", "BRIEF LIMA PANEL:");
    for (const b of briefs) promptParts.push(renderBrief(b));
    if (combinedMeta && combinedMeta.crossConflict.length > 0) {
      promptParts.push("", "KONFLIK LINTAS PANEL (wajib mentioned lebih dulu):");
      for (const c of combinedMeta.crossConflict) promptParts.push(`- ${c}`);
    }
  } else {
    promptParts.push("", "BRIEF PANEL:");
    promptParts.push(renderBrief(briefs[0]!));
  }
  promptParts.push("", "Berikan analisis sesuai tugas Anda. Rujuk angka yang ada; bila data kurang/kurang basi, katakan hilang/basi.");

  const started = Date.now();
  const guard = budget.guardForBatch(opts.batchIndex);
  try {
    // TAHAP 6C: opsi TERUKUR per panel + SATU retry truncation
    // (callPanelWithTruncationRetry). Retry hanya untuk finishReason "length";
    // timeout/HTTP/budget/evidence-basi diteruskan apa adanya.
    const { res, usedTruncationRetry, attempts: callAttempts } = await callPanelWithTruncationRetry(
      panel,
      (callOpts) => defaultLlmAdapter.callReason(promptParts.join("\n"), PANEL_SYSTEM_PROMPTS[panel], {
        ...callOpts,
        // queuePriority "low" (TAHAP 6B): narasi panel mengalah bila ada antrean
        // supervisi/judge — posisi tidak boleh tertunda oleh narasi.
        queuePriority: "low",
        // Fairness: satu simbol hanya mendapat satu giliran per putaran slot.
        fairnessKey: `panel:${symbol}`,
        // Budget keras: diperiksa sebelum attempt pertama DAN sebelum retry.
        budgetGuard: guard,
        // TAHAP 6B: deadline ANTREAN. Tanpa ini, panel bisa menunggu berjam-jam
        // lalu kehabisan waktu provider (bug "combined" 26 Okt 2026). Deadline
        // membuat antrean punya batas dan evidence lama tidak dianalisis.
        queueDeadlineMs: env.PANEL_AI_QUEUE_DEADLINE_MS,
        // Freshness recheck saat giliran tiba (setelah antre): evidence yang
        // sudah basi TIDAK dikirim ke provider.
        preflight: () => {
          const age = Math.max(0, ...evidences.map((e) => e.ageMs ?? 0));
          if (age > PANEL_EVIDENCE_MAX_AGE_MS) {
            throw new LlmEvidenceStaleError(
              `LLM_EVIDENCE_STALE: umur ${Math.round(age / 1000)}dtk > ${Math.round(PANEL_EVIDENCE_MAX_AGE_MS / 1000)}dtk`);
          }
        },
      }),
    );
    if (usedTruncationRetry) panelAiStats.truncationRetries += 1;
    const text = res.content.trim();
    if (!text) throw new Error("LLM_EMPTY");
    const tokens = res.usage?.totalTokens ?? null;
    budget.recordSuccess(res.usage);
    panelAiStats.llmSuccess += 1;
    panelAiStats.success += 1;
    panelAiStats.attempts += callAttempts;
    if (tokens != null) {
      panelAiStats.tokens += tokens;
      panelAiStats.promptTokens += res.usage?.promptTokens ?? 0;
      panelAiStats.completionTokens += res.usage?.completionTokens ?? 0;
    }
    if (res.providerMs != null) panelAiStats.providerMsTotal += res.providerMs;
    await storeAnalysis({
      panel, symbol, status: "LLM_SUCCESS", model: res.model, text,
      evidenceSnapshotId: panel === "combined" ? evidences.map((e) => e.snapshotId).join(",") : ev!.snapshotId,
      evidenceHash: hash, generatedAt: new Date().toISOString(), latencyMs: Date.now() - started,
      providerMs: res.providerMs ?? null, queueWaitMs: res.queueWaitMs ?? opts.queueWaitMs,
      attempts: callAttempts, finishReason: res.finishReason ?? null,
      tokens, promptTokens: res.usage?.promptTokens ?? null, completionTokens: res.usage?.completionTokens ?? null,
      evidenceAgeMs: oldestAge, evidenceFreshness: freshness, errorCode: null,
    });
    logger.info({
      panel, symbol, model: res.model, latencyMs: Date.now() - started,
      providerMs: res.providerMs, queueWaitMs: res.queueWaitMs, attempts: callAttempts,
      usedTruncationRetry, finishReason: res.finishReason, tokens, evidenceAgeMs: oldestAge, evidenceFreshness: freshness,
    }, "PANEL_AI_LLM_SUCCESS");
  } catch (err) {
    // Budget habis / evidence basi = BATAL LOKAL (bukan kegagalan provider).
    if (err instanceof LlmBudgetExceededError) {
      panelAiStats.budgetExhausted += 1;
      panelAiStats.budgetBlockedBeforeSend += 1;
      await storeAnalysis({
        panel, symbol, status: "BUDGET_EXHAUSTED", model: null,
        text: `Budget panel habis sebelum request dikirim — LLM tidak dipanggil. (${(err as Error).message})`,
        evidenceSnapshotId: ev?.snapshotId ?? evidences.map((e) => e.snapshotId).join(","),
        evidenceHash: hash, generatedAt: new Date().toISOString(), latencyMs: Date.now() - started,
        providerMs: null, queueWaitMs: opts.queueWaitMs, attempts: 0, finishReason: null,
        tokens: null, promptTokens: null, completionTokens: null,
        evidenceAgeMs: oldestAge, evidenceFreshness: freshness, errorCode: "BUDGET_EXHAUSTED",
      });
      logger.warn({ panel, symbol, err: (err as Error).message }, "PANEL_AI_BUDGET_BLOCKED");
      return;
    }
    if (err instanceof LlmEvidenceStaleError) {
      panelAiStats.skippedStale += 1;
      await storeAnalysis({
        panel, symbol, status: "STALE", model: null,
        text: `Evidence basi saat antre — LLM tidak dipanggil. (${(err as Error).message})`,
        evidenceSnapshotId: ev?.snapshotId ?? evidences.map((e) => e.snapshotId).join(","),
        evidenceHash: hash, generatedAt: new Date().toISOString(), latencyMs: Date.now() - started,
        providerMs: null, queueWaitMs: opts.queueWaitMs, attempts: 0, finishReason: null,
        tokens: null, promptTokens: null, completionTokens: null,
        evidenceAgeMs: oldestAge, evidenceFreshness: "stale", errorCode: "EVIDENCE_STALE",
      });
      return;
    }
    // Kegagalan provider: FALLBACK berlabel + kode error terstruktur.
    const code = err instanceof LlmLocalAbort ? err.reason
      : (err as { code?: string }).code ?? "LLM_UNAVAILABLE";
    panelAiStats.fallback += 1;
    await storeAnalysis({
      panel, symbol, status: "FALLBACK", model: null,
      text: `${fallbackText(panel, briefs)} (LLM gagal: ${code}: ${(err as Error).message.slice(0, 120)})`,
      evidenceSnapshotId: panel === "combined" ? evidences.map((e) => e.snapshotId).join(",") : ev!.snapshotId,
      evidenceHash: hash, generatedAt: new Date().toISOString(), latencyMs: Date.now() - started,
      providerMs: (err as { providerMs?: number | null }).providerMs ?? null,
      queueWaitMs: (err as { queueWaitMs?: number | null }).queueWaitMs ?? opts.queueWaitMs,
      attempts: (err as { attempts?: number | null }).attempts ?? 0,
      finishReason: (err as { finishReason?: string | null }).finishReason ?? null,
      tokens: null, promptTokens: null, completionTokens: null,
      evidenceAgeMs: oldestAge, evidenceFreshness: freshness, errorCode: code,
    });
    logger.warn({
      panel, symbol, err: (err as Error).message, code,
      providerMs: (err as { providerMs?: number | null }).providerMs,
      queueWaitMs: (err as { queueWaitMs?: number | null }).queueWaitMs,
      attempts: (err as { attempts?: number | null }).attempts,
      finishReason: (err as { finishReason?: string | null }).finishReason,
    }, "PANEL_AI_FALLBACK");
  }
}

/**
 * Pemicu analisis panel: dipanggil dari funnel kandidat / siklus analyst /
 * candle close. Deduplikasi hash + debounce + budget keras; concurrency 1.
 * Fail-open: tidak pernah mengganggu jalur trading.
 */
export function maybeTriggerPanelAnalysis(symbol = "BTC", opts?: { force?: boolean }): void {
  const enqueuedAt = Date.now();
  chain = chain.then(async () => {
    try {
      if (!env.PANEL_AI_ENABLED) return;
      const queueWaitMs = Date.now() - enqueuedAt; // TAHAP 6B: antrean rantai internal
      panelAiStats.queueWaitMsTotal += queueWaitMs;
      const evidences = await gatherPanelEvidence(symbol);
      const hash = evidenceHash(evidences);
      const key = symbol.toUpperCase();
      const budget = getPanelBudget();

      const prev = lastRun.get(key);
      const now = Date.now();
      if (!opts?.force && prev && prev.hash === hash && now - prev.at < env.PANEL_AI_DEBOUNCE_MS) {
        panelAiStats.skippedUnchanged += 1;
        budget.recordCacheHit();
        logger.debug({ symbol, hash }, "PANEL_AI_SKIP_UNCHANGED");
        return;
      }
      // Batas keras per jam: dicek SEBELUM analisis dimulai. Batch yang
      // ditolak tidak mengirim request apa pun (tidak ada overshoot).
      if (budget.remainingRequests() <= 0) {
        panelAiStats.budgetExhausted += 1;
        logger.info({
          symbol, used: budget.getState().attempts, cap: env.PANEL_AI_MAX_PER_HOUR,
        }, "PANEL_AI_BUDGET_EXHAUSTED");
        return;
      }
      lastRun.set(key, { hash, at: now });
      panelAiStats.runs += 1;
      panelAiStats.lastRunAt = now;

      // Batas per batch: 5 panel + combined = 6 request. Kalau jatah batch
      // lebih kecil, request ke-N+1 ditolak guard (tidak terkirim).
      const panels: PanelId[] = [...PANEL_IDS, "combined"];
      for (let i = 0; i < panels.length; i++) {
        await analyzePanel({
          panel: panels[i]!, symbol: key, evidences, hash,
          queueWaitMs, batchIndex: i, force: opts?.force,
        });
      }

      // TAHAP 6B: metrik nyata per run — dipisah: attempt vs success vs
      // cacheHit vs token aktual. Metrik ini KHUSUS panel AI.
      const bs = budget.getState();
      logger.info({
        symbol: key, queueWaitMs, runs: panelAiStats.runs,
        attempts: bs.attempts, success: bs.success, cacheHit: bs.cacheHit,
        llmSuccess: panelAiStats.llmSuccess, fallback: panelAiStats.fallback,
        unavailable: panelAiStats.unavailable, skippedUnchanged: panelAiStats.skippedUnchanged,
        skippedStale: panelAiStats.skippedStale,
        budgetExhausted: panelAiStats.budgetExhausted,
        blockedBeforeSend: bs.blockedBeforeSend,
        tokens: bs.tokens, promptTokens: bs.promptTokens, completionTokens: bs.completionTokens,
        providerMsTotal: panelAiStats.providerMsTotal,
        evidenceAgeMs: Math.max(0, ...evidences.map((e) => e.ageMs ?? 0)) || null,
      }, "PANEL_AI_STATS");

      // Prune ringan: jaga EventLog panel tetap bounded.
      const count = await db.eventLog.count({ where: { type: PANEL_AI_EVENT_TYPE } }).catch(() => 0);
      if (count > 600) {
        const oldest = await db.eventLog.findMany({
          where: { type: PANEL_AI_EVENT_TYPE }, orderBy: { id: "asc" }, take: count - 500, select: { id: true },
        }).catch(() => [] as { id: number }[]);
        if (oldest.length > 0) {
          await db.eventLog.deleteMany({ where: { id: { in: oldest.map((o) => o.id) } } }).catch(() => undefined);
        }
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "PANEL_AI_TRIGGER_FAILED");
    }
  }).catch(() => undefined);
}

/** Read model untuk API/UI: baris terbaru per panel untuk satu simbol. */
export async function readPanelAiLatest(symbol: string, maxAgeMs = 30 * 60_000): Promise<{
  symbol: string; generatedAt: string; panels: Record<string, PanelAiRow | null>; fresh: boolean;
  /** Freshness berbasis evidence sumber (bukan hanya generatedAt). */
  evidenceFreshness: "fresh" | "stale" | "unknown";
}> {
  const rows = await db.eventLog.findMany({
    where: { type: PANEL_AI_EVENT_TYPE }, orderBy: { id: "desc" }, take: 80, select: { payload: true },
  }).catch(() => [] as { payload: string }[]);
  const panels: Record<string, PanelAiRow | null> = {};
  for (const id of [...PANEL_IDS, "combined" as PanelId]) panels[id] = null;
  let newest = 0;
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payload) as PanelAiRow;
      if (p.symbol !== symbol.toUpperCase()) continue;
      const ts = Date.parse(p.generatedAt);
      if (!Number.isFinite(ts)) continue;
      if (ts > newest) newest = ts;
      if (panels[p.panel] == null) panels[p.panel] = p;
    } catch { /* skip */ }
  }
  // Freshness: TTL cache (generatedAt) DAN umur evidence sumber digabung.
  const ages = Object.values(panels)
    .filter((p): p is PanelAiRow => p != null)
    .map((p) => p.evidenceAgeMs)
    .filter((a): a is number => a != null);
  const evidenceFreshness = ages.length === 0 ? "unknown"
    : Math.max(...ages) > PANEL_EVIDENCE_MAX_AGE_MS ? "stale" : "fresh";
  return {
    symbol: symbol.toUpperCase(),
    generatedAt: newest ? new Date(newest).toISOString() : "",
    panels,
    fresh: newest > 0 && Date.now() - newest < maxAgeMs,
    evidenceFreshness,
  };
}

