// Xkiro LLM adapter with usage and failure tracking.
import { env, llmProvider } from "../core/env.js";
import { logger } from "../core/logger.js";
import { getVaultMemoryBlock } from "../learning/vaultMemoryLoader.js";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmCallOptions {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  model?: string;
  reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  /** Prioritas antrean (TAHAP 6B, 26 Okt 2026).
   *  "critical" = jalur kritis (judge entry, supervisi posisi): slot dicadangkan,
   *    narasi tidak boleh mengambil slot terakhir.
   *  "normal"  = default (dialog, sweep, riset) — FIFO di kelasnya.
   *  "low"     = narasi/insight (panel AI dsb): mengalah bila ada antrean std,
   *    DAN tidak boleh menempati slot cadangan (LLM_CRITICAL_RESERVE). */
  queuePriority?: "critical" | "normal" | "low";
  /** Dipanggil SEBELUM setiap attempt HTTP (termasuk percobaan ulang).
   *  Melempar error = batalkan percobaan berikutnya (budget keras pemanggil). */
  budgetGuard?: (attempt: number) => void;
  /** Kunci adil antrean (mis. simbol). Satu kunci hanya mendapat satu giliran
   *  per putaran pelepasan slot, sehingga BTC tidak mengambil seluruh antrean. */
  fairnessKey?: string;
  /**
   * TAHAP 6B: deadline ANTREAN (ms). Batas maksimum menunggu slot. Melewati
   * deadline -> request dibatalkan (LlmLocalAbort "QUEUE_DEADLINE_EXCEEDED")
   * dan TIDAK pernah dikirim ke provider. Tanpa ini, request bisa menunggu
   * berjam-jam lalu kehabisan waktu provider (bug combined 26 Okt 2026).
   */
  queueDeadlineMs?: number;
  /**
   * TAHAP 6B: pemeriksaan SEBELUM request dikirim, dijalankan setelah slot
   * diperoleh (jadi setelah menunggu antrean). Melempar error = request
   * dibatalkan tanpa dikirim (mis. evidence sudah basi saat antre).
   */
  preflight?: () => void;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export interface LlmResponse {
  content: string;
  model: string;
  reasoningEffortRequested?: string;
  usage: LlmUsage;
  latencyMs: number;
  /** TAHAP 6B: waktu tunggu di antrean scheduler (ms) — BUKAN durasi provider. */
  queueWaitMs?: number;
  /** TAHAP 6B: durasi provider saja (ms), dihitung dari request pertama dikirim
   *  sampai respons diterima. Tidak termasuk antrean. */
  providerMs?: number;
  /** TAHAP 6B: jumlah attempt HTTP (termasuk percobaan ulang 429/5xx). */
  attempts?: number;
  /** TAHAP 6B: finish_reason dari provider ("stop" | "length" | ...). */
  finishReason?: string | null;
  /** TAHAP 6B: status HTTP terakhir (null bila tidak pernah ada respons). */
  httpStatus?: number | null;
}

/**
 * TAHAP 6B: error LLM terstruktur. `message` tetap memuat token lama
 * (LLM_RESPONSE_UNAVAILABLE: <CODE>) supaya parser existing (postMortem,
 * fiveWhys) tidak kehilangan klasifikasi; detail baru ada di field terpisah.
 */
export class LlmCallError extends Error {
  readonly code: string;
  readonly httpStatus: number | null;
  readonly attempts: number;
  readonly providerMs: number | null;
  readonly queueWaitMs: number | null;
  readonly finishReason: string | null;
  /** Rincian tambahan: "EMPTY" | "TRUNCATED" | "TIMEOUT" | ... */
  readonly detail: string | null;
  /** Token error LAMA yang tetap muncul di message supaya parser existing
   *  (postMortemEvaluator, fiveWhys) tidak kehilangan klasifikasi lama. */
  readonly legacyCode: string;

  constructor(init: {
    code: string; message?: string; httpStatus?: number | null; attempts?: number;
    providerMs?: number | null; queueWaitMs?: number | null; finishReason?: string | null;
    detail?: string | null; legacyCode?: string;
  }) {
    const legacy = init.legacyCode ?? init.code;
    super(init.message ?? `LLM_RESPONSE_UNAVAILABLE: ${legacy}`);
    this.name = "LlmCallError";
    this.code = init.code;
    this.legacyCode = legacy;
    this.httpStatus = init.httpStatus ?? null;
    this.attempts = init.attempts ?? 0;
    this.providerMs = init.providerMs ?? null;
    this.queueWaitMs = init.queueWaitMs ?? null;
    this.finishReason = init.finishReason ?? null;
    this.detail = init.detail ?? null;
  }
}

/**
 * TAHAP 6B: error LOKAL (bukan kegagalan provider) — mis. budget panel habis
 * atau evidence basi saat antre. Tidak dibungkus jadi LLM_RESPONSE_UNAVAILABLE
 * supaya pemanggil bisa membedakan "provider gagal" dari "kita batalkan".
 */
export class LlmLocalAbort extends Error {
  readonly reason: string;
  constructor(reason: string, message?: string) {
    super(message ?? reason);
    this.name = "LlmLocalAbort";
    this.reason = reason;
  }
}

/** Budget panel habis: error lokal (bukan kegagalan provider). */
export class LlmBudgetExceededError extends LlmLocalAbort {
  constructor(message = "LLM_BUDGET_EXHAUSTED") {
    super("BUDGET_EXHAUSTED", message);
    this.name = "LlmBudgetExceededError";
  }
}

/** Evidence sumber sudah basi saat request akan dikirim — request dibatalkan. */
export class LlmEvidenceStaleError extends LlmLocalAbort {
  constructor(message = "LLM_EVIDENCE_STALE") {
    super("EVIDENCE_STALE", message);
    this.name = "LlmEvidenceStaleError";
  }
}

export interface CostTrackerState {
  dailyCostUsd: number;
  monthlyUsedUsd: number;
  monthlyBudgetUsd: number;
  /** true = tanpa batas (perintah operator): budget <= 0. */
  unlimited: boolean;
  degradeThresholdPct: number;
  degradeThresholdUsd: number;
  isDegraded: boolean;
  totalCalls: number;
  totalTokens: number;
}

export interface LlmClient {
  chat(messages: LlmMessage[], model: string, options?: LlmCallOptions): Promise<LlmResponse>;
}

export function cleanJsonText(raw: string): string {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.replace(/^```json\s*/i, "").replace(/```\s*$/, "");
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```\s*/, "").replace(/```\s*$/, "");
  }
  return cleaned.trim();
}

export class XkiroAdapter {
  private readonly client: LlmClient;
  private readonly modelFast: string;
  private readonly modelReason: string;
  private readonly modelReasonFallbacks: string[];
  private readonly monthlyBudgetUsd: number;
  private readonly degradeThresholdPct: number;

  private dailyCostUsd = 0;
  private monthlyUsedUsd = 0;
  private totalCalls = 0;
  private totalTokens = 0;
  private lastSuccessAt = 0;
  private lastSuccessModel = "";
  private lastSuccessReasoningEffort = "";
  private readonly deepseekClient: LlmClient;

  constructor(options?: {
    client?: LlmClient;
    deepseekClient?: LlmClient;
    modelFast?: string;
    modelReason?: string;
    monthlyBudgetUsd?: number;
    degradeThresholdPct?: number;
    initialMonthlyUsedUsd?: number;
  }) {
    this.client = options?.client ?? defaultHttpClient;
    this.deepseekClient = options?.deepseekClient ?? deepseekHttpClient;
    this.modelFast = normalizeXkiroModelId(options?.modelFast || env.XKIRO_MODEL_FAST || "xiaomi/mimo-v2.6-flash");
    this.modelReason = normalizeXkiroModelId(options?.modelReason || env.XKIRO_MODEL_REASON || "xiaomi/mimo-v2.6-pro");
    this.modelReasonFallbacks = [...new Set(env.XKIRO_MODEL_REASON_FALLBACKS
      .map(normalizeXkiroModelId)
      .filter((candidate) => candidate !== this.modelReason))];
    this.monthlyBudgetUsd = options?.monthlyBudgetUsd ?? env.XKIRO_MONTHLY_BUDGET_USD;
    this.degradeThresholdPct = options?.degradeThresholdPct ?? env.XKIRO_DEGRADE_AT_PCT;
    this.monthlyUsedUsd = options?.initialMonthlyUsedUsd ?? 0;
  }

  isUnlimited(): boolean {
    return !(this.monthlyBudgetUsd > 0);
  }

  isDegraded(): boolean {
    if (this.isUnlimited()) return false;
    const thresholdUsd = (this.monthlyBudgetUsd * this.degradeThresholdPct) / 100;
    return this.monthlyUsedUsd >= thresholdUsd;
  }

  canExecuteCall(isCritical = true): boolean {
    // UNLIMITED: XKIRO_MONTHLY_BUDGET_USD=0 disables the app-side spending cap.
    // semua panggilan selalu diizinkan — daily/weekly/monthly dihapus total.
    if (this.isUnlimited()) return true;
    if (this.monthlyUsedUsd >= this.monthlyBudgetUsd) {
      return false;
    }
    if (this.isDegraded() && !isCritical) {
      return false;
    }
    return true;
  }

  recordUsage(usage: LlmUsage, model = "", reasoningEffort = ""): void {
    this.dailyCostUsd = Number((this.dailyCostUsd + usage.estimatedCostUsd).toFixed(5));
    this.monthlyUsedUsd = Number((this.monthlyUsedUsd + usage.estimatedCostUsd).toFixed(5));
    this.totalCalls += 1;
    this.totalTokens += usage.totalTokens;
    this.lastSuccessAt = Date.now();
    this.lastSuccessModel = model;
    this.lastSuccessReasoningEffort = reasoningEffort;

    if (this.isDegraded()) {
      logger.warn(
        { monthlyUsed: this.monthlyUsedUsd, budget: this.monthlyBudgetUsd, pct: this.degradeThresholdPct },
        "LLM adapter memasuki mode DEGRADASI (pemakaian >= ambang)"
      );
    }
  }

  getTrackerState(): CostTrackerState & { provider: "XKIRO"; modelFast: string; modelReason: string; modelReasonFallbacks: string[]; reasoningEffortRequested: string; lastSuccessAt: number; lastSuccessModel: string; lastSuccessReasoningEffort: string; modelSwitchCount: number; lastModelSwitch: string; fallbackCalls: number; lastFallbackAt: number; lastFallbackModel: string; lastFailureReason: string; deepseek: { enabled: boolean; keysConfigured: number; model: string; failoverCalls: number; lastFailoverAt: number; lastFailoverError: string } } {
    const thresholdUsd = (this.monthlyBudgetUsd * this.degradeThresholdPct) / 100;
    return {
      provider: llmProvider(),
      deepseek: {
        enabled: env.DEEPSEEK_FAILOVER_ENABLED && env.DEEPSEEK_API_KEYS.length > 0,
        keysConfigured: env.DEEPSEEK_API_KEYS.length,
        model: env.DEEPSEEK_MODEL,
        failoverCalls: deepseekFailoverStats.failoverCalls,
        lastFailoverAt: deepseekFailoverStats.lastFailoverAt,
        lastFailoverError: deepseekFailoverStats.lastFailoverError,
      },
      modelFast: this.modelFast,
      modelReason: this.modelReason,
      modelReasonFallbacks: [...this.modelReasonFallbacks],
      reasoningEffortRequested: env.XKIRO_REASONING_EFFORT,
      lastSuccessAt: this.lastSuccessAt,
      lastSuccessModel: this.lastSuccessModel,
      lastSuccessReasoningEffort: this.lastSuccessReasoningEffort,
      modelSwitchCount: modelSwitchStats.count,
      lastModelSwitch: modelSwitchStats.lastTo,
      dailyCostUsd: this.dailyCostUsd,
      monthlyUsedUsd: this.monthlyUsedUsd,
      monthlyBudgetUsd: this.monthlyBudgetUsd,
      unlimited: this.isUnlimited(),
      degradeThresholdPct: this.degradeThresholdPct,
      degradeThresholdUsd: Number(thresholdUsd.toFixed(2)),
      isDegraded: this.isDegraded(),
      totalCalls: this.totalCalls,
      totalTokens: this.totalTokens,
      fallbackCalls: llmFallbackStats.count,
      lastFallbackAt: llmFallbackStats.lastAt,
      lastFallbackModel: llmFallbackStats.lastModel,
      lastFailureReason: llmFallbackStats.lastFailureReason,
    };
  }

  /** Xkiro primer; DeepSeek HANYA bila Xkiro gagal dengan kelas yang memenuhi syarat. */
  private async chatWithFailover(
    messages: LlmMessage[],
    model: string,
    callOptions: LlmCallOptions,
    queuePriority?: LlmCallOptions["queuePriority"],
  ): Promise<LlmResponse> {
    try {
      return await this.client.chat(messages, model, callOptions);
    } catch (err) {
      return this.failoverToDeepseek(messages, callOptions, err, queuePriority);
    }
  }

  private async failoverToDeepseek(
    messages: LlmMessage[],
    callOptions: LlmCallOptions,
    err: unknown,
    queuePriority?: LlmCallOptions["queuePriority"],
  ): Promise<LlmResponse> {
    if (!env.DEEPSEEK_FAILOVER_ENABLED || env.DEEPSEEK_API_KEYS.length === 0) throw err;
    if (!isFailoverEligible(err, queuePriority ?? "normal")) throw err;
    deepseekFailoverStats.failoverCalls += 1;
    deepseekFailoverStats.lastFailoverAt = Date.now();
    deepseekFailoverStats.lastFailoverError = err instanceof Error ? err.message.slice(0, 160) : "";
    logger.warn({ reason: err instanceof Error ? err.message : "unknown" }, "LLM Xkiro gagal; failover ke DeepSeek");
    try {
      return await this.deepseekClient.chat(messages, env.DEEPSEEK_MODEL, callOptions);
    } catch (dsErr) {
      deepseekFailoverStats.lastFailoverError = dsErr instanceof Error ? dsErr.message.slice(0, 160) : "";
      throw dsErr;
    }
  }

  async callFast(userPrompt: string, systemPrompt = "Anda adalah asisten trading kuantitatif profesional.", options?: LlmCallOptions): Promise<LlmResponse> {
    const isCritical = Boolean(options?.model);
    if (!this.canExecuteCall(isCritical)) {
      throw new Error(`LLM call ditolak: batas anggaran bulanan atau degradasi aktif (${this.monthlyUsedUsd}/${this.monthlyBudgetUsd} USD)`);
    }

    const messages: LlmMessage[] = [
      { role: "system", content: systemPrompt + getVaultMemoryBlock() },
      { role: "user", content: userPrompt },
    ];

    const model = options?.model ?? this.modelFast;
    const res = await this.chatWithFailover(messages, model, {
      temperature: options?.temperature ?? 0.2,
      maxTokens: options?.maxTokens ?? 400,
      ...options,
    }, options?.queuePriority);

    this.recordUsage(res.usage, res.model, res.reasoningEffortRequested);
    return res;
  }

  async callReason(userPrompt: string, systemPrompt = "Anda adalah analis penalaran pasar futures kripto.", options?: LlmCallOptions): Promise<LlmResponse> {
    if (!this.canExecuteCall(true)) {
      throw new Error(`LLM call ditolak: batas anggaran bulanan $${this.monthlyBudgetUsd} tercapai`);
    }

    const messages: LlmMessage[] = [
      { role: "system", content: systemPrompt + getVaultMemoryBlock() },
      { role: "user", content: userPrompt },
    ];

    const model = options?.model ?? this.modelReason;
    const candidates = options?.model ? [model] : [model, ...this.modelReasonFallbacks];
    const callOptions = {
      temperature: options?.temperature ?? 0.1,
      maxTokens: options?.maxTokens ?? 900,
      reasoningEffort: options?.reasoningEffort ?? env.XKIRO_REASONING_EFFORT,
      ...options,
    };
    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        const res = await this.client.chat(messages, candidate, callOptions);
        if (candidate !== model) {
          modelSwitchStats.count += 1;
          modelSwitchStats.lastTo = res.model || candidate;
          logger.warn({ requestedModel: model, fallbackModel: res.model || candidate }, "LLM REASON memakai fallback model terkonfigurasi");
        }
        this.recordUsage(res.usage, res.model, res.reasoningEffortRequested);
        return res;
      } catch (err) {
        lastError = err;
        if (candidate !== candidates[candidates.length - 1]) {
          logger.warn({ requestedModel: model, failedModel: candidate }, "Model REASON gagal; mencoba fallback berikutnya");
        }
      }
    }
    try {
      const res = await this.failoverToDeepseek(messages, callOptions, lastError, options?.queuePriority);
      this.recordUsage(res.usage, res.model, res.reasoningEffortRequested);
      return res;
    } catch (err) {
      throw err instanceof Error ? err : new Error("LLM_RESPONSE_UNAVAILABLE");
    }
  }
  async callJson<T = unknown>(
    kind: "fast" | "reason",
    userPrompt: string,
    systemPrompt = "Berikan respons HANYA dalam format valid JSON tanpa penjelasan tambahan."
  ): Promise<{ data: T; response: LlmResponse }> {
    const res = kind === "fast"
      ? await this.callFast(userPrompt, systemPrompt, { maxTokens: 600 })
      : await this.callReason(userPrompt, systemPrompt, { maxTokens: 1000 });

    const cleaned = cleanJsonText(res.content);
    try {
      const data = JSON.parse(cleaned) as T;
      return { data, response: res };
    } catch (err) {
      logger.error({ raw: res.content, cleaned, err }, "Gagal parsing respons JSON dari LLM");
      throw new Error(`Gagal parsing respons JSON dari model ${res.model}: ${(err as Error).message}`);
    }
  }
}

// Observabilitas kegagalan provider; fallback narasi dibuat oleh pemanggil dan diberi label.
export const llmFallbackStats = {
  count: 0,
  lastAt: 0,
  lastModel: "",
  lastFailureReason: "",
  /** 429 yang berhasil dipulihkan retry (bukan kegagalan final). */
  retried429: 0,
};

// ─────────────────────────────────────────────────────────────────────────────
// ANTI-429: pembatas + retry (perintah operator 29 Sep 2026: "AI AGENT LLM bisa
// secara cepat membaca dan menganalisis market pair crypto ... multi paralel").
//
// Bukti runtime sebelum perubahan: 2.636 panggilan GAGAL vs 936 berhasil, dengan
// lastFailureReason=LLM_HTTP_429. Penyebabnya bukan logikanya, melainkan dua
// hal mekanis: (1) banyak panggilan dilepas bersamaan (fan-out judge 8 + Vega
// per kandidat + supervisor) sehingga provider kena rate limit, (2) 429 tidak
// pernah dicoba ulang sehingga satu teguran langsung menjadi NO-GO.
//
// Perbaikan INI TIDAK mengubah isivonis: status HTTP 429/5xx tetap gagal ke
// pemanggil bila seluruh percobaan habis. Yang berubah hanya chances-ladenya
// panggilan yang sebenarnya sehat sempat lewat.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * TAHAP 6B: jumlah slot LLM. DIBACA SAAT PANGGILAN (bukan sekali saat import)
 * supaya batas bisa diuji dan diubah tanpa mengubah siklus import modul.
 */
function llmMaxConcurrency(): number {
  return Math.max(1, Math.min(12, Number(process.env.LLM_MAX_CONCURRENCY) || 4));
}
const LLM_RETRY_429_MAX = Math.max(0, Math.min(5, Number(process.env.LLM_RETRY_429_MAX) || 2));
/**
 * TAHAP 6B: jumlah slot yang DICADANGKAN untuk jalur kritis (judge entry +
 * supervisi posisi). Narasi (priority "low") tidak boleh memakai slot ini
 * sehingga panel AI yang lambat tidak pernah menahan judge.
 * Default: 1 (dari 4 slot) — jalur kritis punya jalurnya sendiri.
 */
function llmCriticalReserve(): number {
  const max = llmMaxConcurrency();
  const raw = Number(process.env.LLM_CRITICAL_RESERVE);
  const want = Number.isFinite(raw) && process.env.LLM_CRITICAL_RESERVE !== undefined ? raw : 1;
  return Math.max(0, Math.min(Math.max(0, max - 1), want));
}

export type LlmQueueClass = "critical" | "normal" | "low";

let llmInFlight = 0;
/** Jumlah slot yang sedang dipakai oleh kelas critical (untuk reservasi). */
let llmCriticalInFlight = 0;
/**
 * Kunci fairness terakhir yang dilayani per kelas. Dipakai supaya satu
 * simbol (mis. BTC) tidak mengambil giliran berturut-turut dan menyisakan
 * simbol lain tanpa giliran.
 */
const lastServedKey = new Map<LlmQueueClass, string>();
const llmWaitQueue: Array<{
  cls: LlmQueueClass;
  /** Kunci_symbol untuk pembagian antrean adil (dipakai panel AI). */
  fairnessKey?: string;
  enqueuedAt: number;
  resolve: () => void;
}> = [];

function classOf(p: LlmQueueClass | undefined): LlmQueueClass {
  return p === "critical" ? "critical" : p === "low" ? "low" : "normal";
}

/**
 * Kapasitas untuk kelas NON-KRITIS (normal + low). Kelas non-kritis tidak
 * boleh memakai seluruh slot: minimal `reserve` slot selalu tersedia untuk
 * jalur kritis (judge entry + supervisi posisi), sehingga panel AI yang lambat
 * tidak pernah menahan judge. Kelas "critical" boleh memakai semua slot.
 */
function nonCriticalCapacity(): number {
  const max = llmMaxConcurrency();
  return Math.max(1, max - llmCriticalReserve());
}

function tryAcquireLlmSlot(cls: LlmQueueClass, fairnessKey?: string): boolean {
  const max = llmMaxConcurrency();
  if (llmInFlight >= max) return false;
  if (cls === "critical") {
    // Kritis boleh memakai slot cadangan.
    llmInFlight += 1;
    llmCriticalInFlight += 1;
    lastServedKey.set(cls, fairnessKey ?? "");
    return true;
  }
  // Non-kritis (normal + low): hormati slot cadangan supaya jalur kritis
  // selalu punya ruang, apa pun antrean narasi/sweep yang ada.
  if (llmInFlight - llmCriticalInFlight >= nonCriticalCapacity()) return false;
  // Narasi (low) mengalah bila ada antrean std/kritis yang menunggu.
  if (cls === "low" && llmWaitQueue.some((w) => w.cls !== "low")) return false;
  llmInFlight += 1;
  lastServedKey.set(cls, fairnessKey ?? "");
  return true;
}

function acquireLlmSlot(
  cls: LlmQueueClass,
  fairnessKey?: string,
  queueDeadlineMs?: number,
): { promise: Promise<void>; enqueuedAt: number; cancel: () => void } {
  const enqueuedAt = Date.now();
  if (tryAcquireLlmSlot(cls, fairnessKey)) {
    return { promise: Promise.resolve(), enqueuedAt, cancel: () => undefined };
  }
  let waiter: { cls: LlmQueueClass; fairnessKey?: string; enqueuedAt: number; resolve: () => void } | null = null;
  let cancelled = false;
  const promise = new Promise<void>((resolve, reject) => {
    waiter = { cls, fairnessKey, enqueuedAt, resolve: () => {
      if (cancelled) return;
      llmInFlight += 1;
      if (cls === "critical") llmCriticalInFlight += 1;
      lastServedKey.set(cls, fairnessKey ?? "");
      resolve();
    } };
    llmWaitQueue.push(waiter);
    // TAHAP 6B: deadline antrean. Melewati deadline -> batal, request TIDAK
    // dikirim (tidak lagi "antre 5 menit lalu timeout provider").
    if (queueDeadlineMs != null && queueDeadlineMs > 0) {
      const timer = setTimeout(() => {
        if (cancelled) return;
        cancelled = true;
        const idx = llmWaitQueue.indexOf(waiter!);
        if (idx >= 0) llmWaitQueue.splice(idx, 1);
        reject(new LlmLocalAbort("QUEUE_DEADLINE_EXCEEDED",
          `LLM_QUEUE_DEADLINE_EXCEEDED: menunggu slot ${queueDeadlineMs}ms`));
      }, queueDeadlineMs);
      // Jangan tahan event loop untuk timer deadline.
      timer.unref?.();
    }
  });
  return {
    promise,
    enqueuedAt,
    cancel: () => { cancelled = true; },
  };
}

function releaseLlmSlot(cls: LlmQueueClass): void {
  llmInFlight = Math.max(0, llmInFlight - 1);
  if (cls === "critical") llmCriticalInFlight = Math.max(0, llmCriticalInFlight - 1);
  // Lepaskan slot: waiter critical lebih dulu, lalu normal, lalu low
  // (anti-starvation: low tetap dapat giliran saat tidak ada pesaing).
  const order: LlmQueueClass[] = ["critical", "normal", "low"];
  for (const c of order) {
    // Fairness (TAHAP 6B): dalam kelas yang sama, giliran diberikan ke kunci
    // yang BERBEDA dari kunci yang terakhir dilayani. Kalau semua waiter punya
    // kunci yang sama, ambil yang paling lama menunggu. Efeknya: BTC tidak
    // bisa mengambil seluruh antrean narasi.
    const lastKey = lastServedKey.get(c) ?? "";
    let pick = -1;
    let bestAge = -1;
    for (let i = 0; i < llmWaitQueue.length; i++) {
      const w = llmWaitQueue[i]!;
      if (w.cls !== c) continue;
      const key = w.fairnessKey ?? "";
      const isDifferent = key !== lastKey;
      const age = Date.now() - w.enqueuedAt;
      // Prioritaskan kunci berbeda; kalau tidak ada, pakai yang terlama.
      if (pick < 0) { pick = i; bestAge = age; continue; }
      const pickedKey = llmWaitQueue[pick]!.fairnessKey ?? "";
      const pickedDiff = pickedKey !== lastKey;
      if (isDifferent && !pickedDiff) { pick = i; bestAge = age; continue; }
      if (isDifferent === pickedDiff && age > bestAge) { pick = i; bestAge = age; }
    }
    if (pick >= 0) {
      const next = llmWaitQueue.splice(pick, 1)[0]!;
      next.resolve();
      return;
    }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retry-After (detik) bila ada, selain itu backoff eksponensial + jitter. */
function retryDelayMs(attempt: number, retryAfterHeader: string | null): number {
  const parsed = Number(retryAfterHeader);
  if (Number.isFinite(parsed) && parsed >= 0) return Math.min(20_000, parsed * 1000);
  return Math.min(8_000, 900 * 2 ** attempt) + Math.floor(Math.random() * 350);
}

// Peralihan model hanya mengikuti fallback yang operator konfigurasi secara
// eksplisit; tier free/paid mengikuti katalog Xkiro, tanpa route tambahan otomatis.
const modelSwitchStats = { count: 0, lastTo: "" };

/** xKiro requires full vendor/model IDs; known bare model names are normalized. */
export function normalizeXkiroModelId(model: string): string {
  const id = model.trim();
  if (id.includes("/")) return id;
  if (id === "mimo-v2.6-flash") return "xiaomi/mimo-v2.6-flash";
  if (id === "mimo-v2.6-pro") return "xiaomi/mimo-v2.6-pro";
  throw new Error(`XKIRO_MODEL_ID_REQUIRES_VENDOR_PREFIX: ${id}`);
}

// DeepSeek (Lighthouse) — provider failover. Antrean dan slot SENDIRI, tidak
// memakai acquireLlmSlot Xkiro: kegagalan antrean Xkiro tidak boleh menular ke
// sini. Rotasi key round-robin agar limit per key tidak jadi bottleneck.
// Probe 28 Okt 2026: 4/4 key 200 pada /models dan chat; reasoning_effort diterima;
// model reasoning memakan max_tokens kecil (finish=length, content kosong),
// sehingga pola content-retry Xkiro juga dipakai di sini.
const DEEPSEEK_CONCURRENCY = 4;
const DEEPSEEK_PRICE_IN_PER_TOKEN = 0.00000001;
const DEEPSEEK_PRICE_OUT_PER_TOKEN = 0.00000007;
let deepseekInFlight = 0;
const deepseekWaiters: Array<() => void> = [];
let deepseekKeyCursor = 0;
export const deepseekFailoverStats = {
  configuredKeys: 0,
  failoverCalls: 0,
  lastFailoverAt: 0,
  lastFailoverError: "",
};

function nextDeepseekKey(keys: string[]): string {
  const key = keys[deepseekKeyCursor % keys.length]!;
  deepseekKeyCursor += 1;
  return key;
}

const DEEPSEEK_QUEUE_DEADLINE_MS = 30_000;

async function acquireDeepseekSlot(): Promise<void> {
  if (deepseekInFlight < DEEPSEEK_CONCURRENCY) {
    deepseekInFlight += 1;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const waiter = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      const idx = deepseekWaiters.indexOf(waiter);
      if (idx >= 0) deepseekWaiters.splice(idx, 1);
      reject(new LlmLocalAbort("QUEUE_DEADLINE_EXCEEDED", `LLM_QUEUE_DEADLINE_EXCEEDED: DeepSeek menunggu slot ${DEEPSEEK_QUEUE_DEADLINE_MS}ms`));
    }, DEEPSEEK_QUEUE_DEADLINE_MS);
    deepseekWaiters.push(waiter);
  });
}

function releaseDeepseekSlot(): void {
  const next = deepseekWaiters.shift();
  if (next) next();
  else deepseekInFlight = Math.max(0, deepseekInFlight - 1);
}

export const deepseekHttpClient: LlmClient = {
  async chat(messages: LlmMessage[], model: string, options?: LlmCallOptions): Promise<LlmResponse> {
    const keys = env.DEEPSEEK_API_KEYS;
    if (!env.DEEPSEEK_FAILOVER_ENABLED || keys.length === 0) {
      throw new LlmCallError({ code: "LLM_PROVIDER_UNAVAILABLE", detail: "DEEPSEEK_DISABLED" });
    }
    const base = env.DEEPSEEK_BASE_URL.replace(/\/+$/, "");
    const deepseekModel = env.DEEPSEEK_MODEL || model;
    const key = nextDeepseekKey(keys);
    const body: Record<string, unknown> = {
      model: deepseekModel,
      messages,
      temperature: options?.temperature ?? 0.2,
      max_tokens: options?.maxTokens ?? 400,
      user: `artatrade-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      ...(options?.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
    };
    const t0 = Date.now();
    await acquireDeepseekSlot();
    const queueWaitMs = Date.now() - t0;
    const providerStart = Date.now();
    let attempts = 0;
    let lastStatus: number | null = null;
    let finishReason: string | null = null;
    try {
      options?.preflight?.();
      options?.budgetGuard?.(0);
      attempts = 1;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), options?.timeoutMs ?? 25_000);
      let r: Response;
      try {
        r = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "User-Agent": "privatetrade-engine/0.1" },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      lastStatus = r.status;
      if (!r.ok) {
        await r.body?.cancel();
        throw new LlmCallError({ code: `LLM_HTTP_${r.status}`, httpStatus: r.status, attempts, providerMs: Date.now() - providerStart, queueWaitMs, finishReason });
      }
      let json = await r.json() as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      finishReason = json.choices?.[0]?.finish_reason ?? null;
      let content = json.choices?.[0]?.message?.content ?? "";
      if (!content.trim() || finishReason === "length") {
        const retryBudget = Math.min(4_000, Math.max(1_500, (options?.maxTokens ?? 400) * 4));
        const retryBody = JSON.stringify({
          ...body,
          max_tokens: retryBudget,
          user: `artatrade-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
          ...(options?.reasoningEffort ? { reasoning_effort: "low" } : {}),
        });
        options?.budgetGuard?.(attempts);
        attempts += 1;
        const ctrl2 = new AbortController();
        const timer2 = setTimeout(() => ctrl2.abort(), options?.timeoutMs ?? 25_000);
        let r2: Response;
        try {
          r2 = await fetch(`${base}/chat/completions`, {
            method: "POST",
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "User-Agent": "privatetrade-engine/0.1" },
            body: retryBody,
            signal: ctrl2.signal,
          });
        } finally {
          clearTimeout(timer2);
        }
        lastStatus = r2.status;
        if (!r2.ok) {
          await r2.body?.cancel();
          throw new LlmCallError({ code: `LLM_HTTP_${r2.status}`, httpStatus: r2.status, attempts, providerMs: Date.now() - providerStart, queueWaitMs, finishReason });
        }
        json = await r2.json() as typeof json;
        finishReason = json.choices?.[0]?.finish_reason ?? null;
        content = json.choices?.[0]?.message?.content ?? "";
      }
      if (!content.trim() || finishReason === "length") {
        throw new LlmCallError({
          code: finishReason === "length" ? "LLM_TRUNCATED_RESPONSE" : "LLM_EMPTY_RESPONSE",
          legacyCode: "LLM_EMPTY_OR_TRUNCATED_RESPONSE",
          httpStatus: lastStatus, attempts, providerMs: Date.now() - providerStart, queueWaitMs, finishReason,
          detail: finishReason === "length" ? "TRUNCATED" : "EMPTY",
        });
      }
      const promptTokens = json.usage?.prompt_tokens ?? Math.round(JSON.stringify(messages).length / 4);
      const completionTokens = json.usage?.completion_tokens ?? Math.round(content.length / 4);
      const totalTokens = json.usage?.total_tokens ?? (promptTokens + completionTokens);
      const costUsd = Number(((promptTokens * DEEPSEEK_PRICE_IN_PER_TOKEN) + (completionTokens * DEEPSEEK_PRICE_OUT_PER_TOKEN)).toFixed(8));
      return {
        content,
        model: deepseekModel,
        reasoningEffortRequested: options?.reasoningEffort,
        usage: { promptTokens, completionTokens, totalTokens, estimatedCostUsd: costUsd },
        latencyMs: Date.now() - providerStart,
        queueWaitMs,
        providerMs: Date.now() - providerStart,
        attempts,
        finishReason,
        httpStatus: lastStatus,
      };
    } catch (err) {
      if (err instanceof LlmLocalAbort || err instanceof LlmCallError) throw err;
      const code = err instanceof Error && err.name === "AbortError" ? "LLM_TIMEOUT" : "LLM_NETWORK_ERROR";
      throw new LlmCallError({ code, httpStatus: lastStatus, attempts, providerMs: Date.now() - providerStart, queueWaitMs, finishReason, detail: code === "LLM_TIMEOUT" ? "TIMEOUT" : "NETWORK" });
    } finally {
      releaseDeepseekSlot();
    }
  },
};

/** Failover hanya untuk kegagalan provider Xkiro yang memenuhi syarat; lokal/budget tidak. */
export function isFailoverEligible(err: unknown, queueClass: string): boolean {
  if (err instanceof LlmLocalAbort) {
    return err.reason === "QUEUE_DEADLINE_EXCEEDED" && queueClass !== "low";
  }
  if (!(err instanceof LlmCallError)) return false;
  const code = err.code;
  // 29 Okt 2026: LLM_EMPTY/TRUNCATED_RESPONSE juga layak di-failover. Bukti:
  // 41/72 kegagalan arena THESIS_PROPOSAL_FAIL adalah kelas ini (model reasoning
  // memakan max_tokens -> content kosong/terpotong). Content-retry di chat() sudah
  // mencoba sekali dengan budget lebih besar + effort turun; kalau masih gagal,
  // DeepSeek (provider/model beda) adalah peluang kedua yang wajar. Fail-closed
  // tetap: bila DeepSeek juga gagal, error diteruskan apa adanya.
  return code === "LLM_TIMEOUT" || code === "LLM_NETWORK_ERROR"
    || code === "LLM_EMPTY_RESPONSE" || code === "LLM_TRUNCATED_RESPONSE"
    || /^LLM_HTTP_(403|429|5\d\d)$/.test(code);
}

export const defaultHttpClient: LlmClient = {
  async chat(messages: LlmMessage[], model: string, options?: LlmCallOptions): Promise<LlmResponse> {
    const key = env.XKIRO_API_KEY;
    if (!key) {
      throw new Error("LLM_API_KEY_NOT_CONFIGURED");
    }

    const base = (env.XKIRO_BASE_URL || "https://api.xkiro.com/v1").replace(/\/+$/, "");
    // 28 Okt 2026 (insiden THESIS_PROPOSAL_FAIL 22x/8jam): upstream Xkiro
    // MEN-CACHE respons per hash body request — body identik dibalas salinan
    // yang sama dalam <50ms (id completion sama), sehingga retry dengan body
    // identik (baik retry status HTTP maupun retry pemanggil) selalu mengulang
    // kegagalan yang sama. `user` = nonce unik per chat() (field standar
    // OpenAI; terverifikasi diterima Xkiro dan memecah cache) — DIPAKAI UNTUK
    // SETIAP chat() baru. Retry status HTTP dalam satu chat() tetap memakai
    // body identik (kontrak uji), retry isi memakai body berbeda.
    const body = {
      model,
      messages,
      temperature: options?.temperature ?? 0.2,
      max_tokens: options?.maxTokens ?? 400,
      user: `artatrade-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      ...(options?.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
    };

    const queueCls = classOf(options?.queuePriority);
    const t0 = Date.now();
    // Budget timeout mengikuti pemanggil; retry hanya terjadi saat status HTTP
    // status HTTP menandakan rate limit (429) / server transient (5xx).
    let ctrl: AbortController | null = null;
    let timer: NodeJS.Timeout | null = null;
    let actualModel = model;
    let attempts = 0;
    let lastStatus: number | null = null;
    let finishReason: string | null = null;

    // TAHAP 6B: antrean dipisah dari durasi provider. queueWaitMs = waktu
    // sampai slot didapat; providerMs = waktu request pertama dikirim sampai
    // respons diterima. Timeout provider dihitung DARI saat request dikirim,
    // bukan dari saat antrean masuk (sebelumnya timeout ikut menunggu antrean).
    // CATATAN: yang di-await adalah `slot.promise` (bukan objek slot) —
    // awaits objek akan langsung selesai tanpa menunggu slot.
    // Deadline antrean (opsional): melewati batas -> batal lokal, request
    // TIDAK dikirim ke provider.
    const slot = acquireLlmSlot(queueCls, options?.fairnessKey, options?.queueDeadlineMs);
    try {
      await slot.promise;
    } catch (err) {
      // Batal saat antrean: slot belum sempat dipakai, jadi tidak ada yang
      // perlu dilepas (dan tidak ada request yang terkirim).
      throw err;
    }
    const queueWaitMs = Date.now() - slot.enqueuedAt;
    const providerStart = Date.now();
    try {
      const requestBody = JSON.stringify(body);
      const send = (payload: string) => {
        ctrl = new AbortController();
        timer = setTimeout(() => ctrl!.abort(), options?.timeoutMs ?? 25000);
        return fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            "User-Agent": "privatetrade-engine/0.1",
          },
          body: payload,
          signal: ctrl.signal,
        });
      };
      const clearAttempt = () => {
        if (timer) { clearTimeout(timer); timer = null; }
      };

      // TAHAP 6B: budget keras pemanggil diperiksa SEBELUM setiap attempt
      // (termasuk retry 429/5xx). Guard yang melempar = tidak ada request
      // yang dikirim, jadi retry TIDAK bisa memakai jatah di luar budget.
      const guard = (attempt: number) => {
        try { options?.budgetGuard?.(attempt); }
        catch (err) { throw err; }
      };
      // Preflight: dijalankan SETELAH antrean, sebelum request dikirim.
      // Melempar = batal lokal (request tidak dikirim, slot dilepas di finally).
      // Diletakkan SEBELUM guard supaya request yang batal tidak dihitung
      // sebagai attempt (tidak ada request yang benar-benar terkirim).
      options?.preflight?.();
      guard(0);
      attempts = 1;
      let r = await send(requestBody);
      // 429 = rate limit provider (bukan penilaian LLM); 5xx = transient upstream.
      // 403 = blokir intermiten Cloudflare/WAF upstream Xkiro (error code 1010;
      // insiden 28 Okt 2026: LLM_HTTP_403 serentak -> 46x THESIS_PROPOSAL_FAIL ->
      // gate fail-closed memveto kandidat sehat). Ikut dicoba ulang dalam budget
      // kecil yang sama; 403 persisten (auth/key) tetap gagal sebagai LLM_HTTP_403.
      // Percobaan ulang memakai Retry-After bila ada, selain itu backoff + jitter.
      // WAJIB dihormati: total waktu retry TIDAK boleh mendekati deadline
      // pemanggil dan TIDAK boleh menunda rantai fallback model yang biasanya
      // berhasil. Anggaran sengaja kecil (±2,5 dtk): cukup untuk satu teguran
      // rate-limit yang sesaat, tidak cukup untuk menunggu Retry-After panjang.
      const budgetMs = Math.min(2_500, Math.max(600, (options?.timeoutMs ?? 25_000) * 0.25));
      const maxAttempts = LLM_RETRY_429_MAX + 1;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (r.ok || ![403, 429, 500, 502, 503, 504].includes(r.status)) break;
        if (attempt === maxAttempts - 1) break;
        const retryAfter = r.headers.get("retry-after");
        const delay = retryDelayMs(attempt, retryAfter);
        if (Date.now() - providerStart + delay > budgetMs) break;
        await r.body?.cancel();
        clearAttempt();
        if (r.status === 429) llmFallbackStats.retried429 += 1;
        await sleep(delay);
        // Guard SETELAH jeda: retry juga memakai jatah request pemanggil.
        guard(attempt + 1);
        attempts += 1;
        r = await send(requestBody);
      }
      lastStatus = r.status;
      let ms = Date.now() - providerStart;
      if (!r.ok) {
        await r.body?.cancel();
        throw new LlmCallError({
          code: `LLM_HTTP_${r.status}`,
          httpStatus: r.status,
          attempts,
          providerMs: ms,
          queueWaitMs,
          finishReason,
        });
      }

      let json = await r.json() as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };

      finishReason = json.choices?.[0]?.finish_reason ?? null;
      let content = json.choices?.[0]?.message?.content ?? "";
      // 28 Okt 2026 (insiden THESIS_PROPOSAL_FAIL 22x/8jam, "Cannot update
      // oldest data" di chart terpisah): model reasoning (mimo) memasukkan
      // token reasoning ke dalam max_tokens — budget kecil (200-700 di banyak
      // call site) sering habis untuk reasoning sehingga content kosong atau
      // finish "length". Ditambah perilaku cache upstream: body identik dibalas
      // salinan respons yang sama dalam <50ms, sehingga retry body identik
      // (termasuk retry pemanggil) selalu mengulang kegagalan yang sama.
      // TEPAT SATU retry isi (bukan timeout/HTTP/budget — itu punya remedi
      // sendiri): budget output lebih besar + effort lebih rendah bila diminta
      // + nonce `user` baru (body berbeda = cache miss, regenerasi nyata).
      // Tetap melewati budgetGuard yang sama — retry = attempt sungguhan.
      if (!content.trim() || finishReason === "length") {
        const retryBudget = Math.min(4_000, Math.max(1_500, (options?.maxTokens ?? 400) * 4));
        const retryBody = JSON.stringify({
          ...body,
          max_tokens: retryBudget,
          user: `artatrade-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
          ...(options?.reasoningEffort ? { reasoning_effort: "low" } : {}),
        });
        clearAttempt();
        guard(attempts);
        attempts += 1;
        r = await send(retryBody);
        lastStatus = r.status;
        ms = Date.now() - providerStart;
        if (r.ok) {
          json = await r.json() as typeof json;
          finishReason = json.choices?.[0]?.finish_reason ?? null;
          content = json.choices?.[0]?.message?.content ?? "";
        } else {
          await r.body?.cancel();
          throw new LlmCallError({
            code: `LLM_HTTP_${r.status}`,
            httpStatus: r.status,
            attempts,
            providerMs: ms,
            queueWaitMs,
            finishReason,
          });
        }
      }
      if (!content.trim() || finishReason === "length") {
        // TAHAP 6B: bedakan KOSONG vs TERPOTONG — dua sebab berbeda, jangan
        // disatukan jadi satu kode. Token LAMA tetap ikut di message supaya
        // parser existing (postMortem/fiveWhys) tidak kehilangan klasifikasi.
        const truncated = finishReason === "length";
        throw new LlmCallError({
          code: truncated ? "LLM_TRUNCATED_RESPONSE" : "LLM_EMPTY_RESPONSE",
          legacyCode: "LLM_EMPTY_OR_TRUNCATED_RESPONSE",
          httpStatus: r.status,
          attempts,
          providerMs: ms,
          queueWaitMs,
          finishReason,
          detail: truncated ? "TRUNCATED" : "EMPTY",
        });
      }
      if (actualModel !== model) {
        modelSwitchStats.count += 1;
        modelSwitchStats.lastTo = actualModel;
      }
      const promptTokens = json.usage?.prompt_tokens ?? Math.round(JSON.stringify(messages).length / 4);
      const completionTokens = json.usage?.completion_tokens ?? Math.round(content.length / 4);
      const totalTokens = json.usage?.total_tokens ?? (promptTokens + completionTokens);

      const costUsd = Number(((promptTokens * 0.00000015) + (completionTokens * 0.00000060)).toFixed(6));

      return {
        content,
        model: actualModel,
        reasoningEffortRequested: options?.reasoningEffort,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens,
          estimatedCostUsd: costUsd,
        },
        latencyMs: ms,
        queueWaitMs,
        providerMs: ms,
        attempts,
        finishReason,
        httpStatus: r.status,
      };
    } catch (err) {
      // Never represent a provider/network failure as an AI-generated opinion.
      const providerMs = Date.now() - providerStart;
      if (err instanceof LlmLocalAbort) throw err; // batal lokal, bukan provider
      if (err instanceof LlmCallError) {
        llmFallbackStats.count += 1;
        llmFallbackStats.lastAt = Date.now();
        llmFallbackStats.lastModel = actualModel;
        llmFallbackStats.lastFailureReason = err.code;
        throw err;
      }
      llmFallbackStats.count += 1;
      llmFallbackStats.lastAt = Date.now();
      llmFallbackStats.lastModel = actualModel;
      const code = err instanceof Error && /^LLM_[A-Z0-9_]+$/.test(err.message)
        ? err.message : err instanceof Error && err.name === "AbortError" ? "LLM_TIMEOUT" : "LLM_NETWORK_ERROR";
      llmFallbackStats.lastFailureReason = code;
      throw new LlmCallError({
        code,
        httpStatus: lastStatus,
        attempts,
        providerMs,
        queueWaitMs,
        finishReason,
        detail: code === "LLM_TIMEOUT" ? "TIMEOUT" : "NETWORK",
      });
    } finally {
      if (timer) clearTimeout(timer);
      releaseLlmSlot(queueCls);
    }
  },
};

export const defaultLlmAdapter = new XkiroAdapter();

