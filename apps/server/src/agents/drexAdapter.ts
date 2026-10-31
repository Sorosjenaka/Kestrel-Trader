// apps/server/src/agents/drexAdapter.ts
// Adapter lapisan keputusan Drex (NaceAI) — POST {base}/v1/systemone.
// Kontrak pertanyaan/jawaban diverifikasi dari docs.drex.nace.ai (3 Okt 2026):
//   noul   -> {"type":"noul","instructions",...}          jawaban: probabilitas yes 0..1
//   choice -> {"type":"choice","instructions","criteria"} jawaban: {choice, probabilities, confidence}
//   score  -> {"type":"score","instructions","criteria"}  jawaban: {score, legend, probabilities, confidence}
//   criteria score = array label level (index = skor); criteria choice = map label -> kriteria.
// Batas: 512 pertanyaan/request, body 1 MiB; 422 = bad request (jangan retry),
// 429/529 = rate/overload (retry hormati Retry-After).
//
// BATASAN KEAMANAN (kontrak integrasi):
// - Adapter ini TIDAK PERNAH menyentuh eksekusi/akun Binance.
// - Tidak pernah menghasilkan harga/ukuran posisi — semua angka uang tetap milik kode.
// - Tidak pernah mencetak/menyimpan API key; hanya status SET/MISSING.
import { env } from "../core/env.js";
import { logger } from "../core/logger.js";

export interface DrexNoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true?: string | null; false?: string | null };
}
export interface DrexChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}
export interface DrexScoreQuestion {
  type: "score";
  instructions: string;
  /** Label level terurut rendah -> tinggi; array index = skor. */
  criteria: string[];
}
export type DrexQuestion = DrexNoulQuestion | DrexChoiceQuestion | DrexScoreQuestion;
export type DrexQuestions = Record<string, DrexQuestion>;

export interface DrexNoulAnswer {
  type: "noul";
  /** Probabilitas "yes" 0..1 (dokumen Drex: noul adalah angka, bukan verdict). */
  probability: number;
}
export interface DrexChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number | null;
  probabilities: Record<string, number> | null;
}
export interface DrexScoreAnswer {
  type: "score";
  score: number;
  confidence: number | null;
  legend: string[] | null;
  probabilities: Record<string, number> | null;
}
export type DrexAnswer = DrexNoulAnswer | DrexChoiceAnswer | DrexScoreAnswer;

/** Latensi terukur (req. scalping): request = kirim->header, response = header->body. */
export interface DrexLatency {
  requestMs: number;
  responseMs: number;
  totalMs: number;
}

export interface DrexEvaluateOk {
  model: string;
  requestId: string | null;
  evaluationTimeMs: number | null;
  latency: DrexLatency;
  answers: Record<string, DrexAnswer>;
  /** Blok mentah persis seperti diterima — untuk replay ambang/debug, bukan untuk eksekusi. */
  raw: unknown;
}

export type DrexErrorCode =
  | "DREX_DISABLED"
  | "DREX_NO_API_KEY"
  | "DREX_BAD_REQUEST"
  | "DREX_RATE_LIMITED"
  | "DREX_TIMEOUT"
  | "DREX_UNAVAILABLE"
  | "DREX_MALFORMED_RESPONSE";

export type DrexResult =
  | { ok: true; data: DrexEvaluateOk }
  | { ok: false; code: DrexErrorCode; detail: string; latency?: DrexLatency };

export type DrexFetch = (url: string, init: RequestInit) => Promise<Response>;
export type DrexSleep = (ms: number) => Promise<void>;

/**
 * Opsi vision (24 Okt 2026): daftar string base64 PNG (atau data URL) yang
 * dikirim lewat field `images` agar Drex-Max menilai dari GAMBAR chart.
 * Batas vendor: maks 8 gambar/request; `drex-v1.5` menolak field images (422).
 */
export interface DrexEvaluateOptions {
  /** String base64 mentah PNG, atau data URL `data:image/png;base64,...`. */
  images?: string[] | null;
}

/** Batas body request Drex (dokumentasi vendor): 1 MiB. */
export const DREX_MAX_BODY_BYTES = 1024 * 1024;
/** Batas jumlah gambar per request (dokumentasi vendor). */
export const DREX_MAX_IMAGES = 8;

/** Model Drex yang mendukung vision (hanya drex-max yang menerima field images). */
export function drexModelSupportsVision(model: string): boolean {
  return /drex-max/i.test(model);
}

const RETRYABLE_CODES: ReadonlySet<DrexErrorCode> = new Set([
  "DREX_RATE_LIMITED",
  "DREX_TIMEOUT",
  "DREX_UNAVAILABLE",
]);

function isFiniteIn(n: unknown, lo: number, hi: number): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= lo && n <= hi;
}

function numRecord(v: unknown): Record<string, number> | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== "number" || !Number.isFinite(val)) return null;
    out[k] = val;
  }
  return out;
}

function parseNoulAnswer(qid: string, a: Record<string, unknown>): DrexNoulAnswer | null {
  if (a.type !== "noul") return null;
  // Dokumen menyebut nilainya "noul is a number from 0 to 1" (field mengulang tipe),
  // tapi contoh JSON eksplisit untuk noul tidak ditampilkan — terima alias yang
  // mungkin dipakai, dan catat kuncinya di log tanpa menyentuh nilai lain.
  for (const key of ["noul", "probability", "value"] as const) {
    const v = a[key];
    if (isFiniteIn(v, 0, 1)) return { type: "noul", probability: v };
  }
  logger.warn({ qid }, "DREX_PARSE: jawaban noul tanpa skalar probabilitas valid");
  return null;
}

function parseChoiceAnswer(_qid: string, a: Record<string, unknown>): DrexChoiceAnswer | null {
  if (a.type !== "choice" || typeof a.choice !== "string" || a.choice === "") return null;
  const confidence = isFiniteIn(a.confidence, 0, 1) ? a.confidence : null;
  return { type: "choice", choice: a.choice, confidence, probabilities: numRecord(a.probabilities) };
}

function parseScoreAnswer(_qid: string, a: Record<string, unknown>): DrexScoreAnswer | null {
  if (a.type !== "score" || typeof a.score !== "number" || !Number.isFinite(a.score)) return null;
  const legend = Array.isArray(a.legend) && a.legend.every((x) => typeof x === "string") ? (a.legend as string[]) : null;
  const confidence = isFiniteIn(a.confidence, 0, 1) ? a.confidence : null;
  return { type: "score", score: a.score, confidence, legend, probabilities: numRecord(a.probabilities) };
}

/**
 * Parse blok `answers` respons Drex dengan validasi struktur ketat.
 * Struktur tak dikenal -> null (failover ke judge LLM), TIDAK PERNAH ditebak isinya.
 */
export function parseDrexAnswers(body: unknown, expected: DrexQuestions): Record<string, DrexAnswer> | null {
  if (typeof body !== "object" || body === null) return null;
  const answers = (body as Record<string, unknown>).answers;
  if (typeof answers !== "object" || answers === null || Array.isArray(answers)) return null;
  const out: Record<string, DrexAnswer> = {};
  for (const qid of Object.keys(expected)) {
    const raw = (answers as Record<string, unknown>)[qid];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const a = raw as Record<string, unknown>;
    const parsed =
      expected[qid].type === "noul" ? parseNoulAnswer(qid, a)
        : expected[qid].type === "choice" ? parseChoiceAnswer(qid, a)
          : parseScoreAnswer(qid, a);
    if (!parsed) return null;
    out[qid] = parsed;
  }
  return out;
}

export class DrexAdapter {
  private readonly fetchImpl: DrexFetch;
  private readonly sleep: DrexSleep;

  constructor(opts?: { fetchImpl?: DrexFetch; sleep?: DrexSleep }) {
    this.fetchImpl = opts?.fetchImpl ?? ((url, init) => fetch(url, init));
    this.sleep = opts?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Aktif hanya bila flag hidup DAN key tersedia (tanpa key tidak ada panggilan keluar). */
  get enabled(): boolean {
    return env.DREX_ENABLED && env.DREX_API_KEY.trim() !== "";
  }

  endpoint(): string {
    return `${env.DREX_BASE_URL.replace(/\/+$/, "")}/v1/systemone`;
  }

  async evaluate(state: unknown, questions: DrexQuestions, options?: DrexEvaluateOptions): Promise<DrexResult> {
    if (!env.DREX_ENABLED) return { ok: false, code: "DREX_DISABLED", detail: "DREX_ENABLED=false" };
    if (env.DREX_API_KEY.trim() === "") return { ok: false, code: "DREX_NO_API_KEY", detail: "DREX_API_KEY MISSING" };
    let res = await this.once(state, questions, options);
    if (res.ok || !RETRYABLE_CODES.has(res.code)) return res;
    await this.sleep(res.code === "DREX_RATE_LIMITED" ? 300 : 250);
    res = await this.once(state, questions, options);
    return res;
  }

  /**
   * Susun field `images` untuk request vision.
   * Aturan fail-safe (tidak pernah melempar):
   * - DREX_VISION_ENABLED=false -> TIDAK ADA gambar (perilaku default, produksi utuh).
   * - model bukan drex-max -> TIDAK ADA gambar (drex-v1.5 balas 422 untuk images).
   * - jumlah gambar > 8 -> dipotong ke 8.
   * - body melebihi 1 MiB -> gambar dibuang (fail-open ke mode JSON).
   */
  private buildImages(options?: DrexEvaluateOptions): string[] | null {
    if (!env.DREX_VISION_ENABLED) return null;
    if (!drexModelSupportsVision(env.DREX_MODEL)) {
      logger.warn({ model: env.DREX_MODEL }, "DREX_VISION_SKIPPED: model tidak mendukung images");
      return null;
    }
    const raw = (options?.images ?? []).filter((s): s is string => typeof s === "string" && s.length > 0);
    if (raw.length === 0) return null;
    return raw.slice(0, DREX_MAX_IMAGES);
  }

  /** Satu percobaan HTTP; latensi request/response diukur terpisah. */
  private async once(state: unknown, questions: DrexQuestions, options?: DrexEvaluateOptions): Promise<DrexResult> {
    const images = this.buildImages(options);
    const payload: Record<string, unknown> = { model: env.DREX_MODEL, state, questions };
    if (images) payload.images = images;
    let body = JSON.stringify(payload);
    // Batas body 1 MiB: gambar dibuang lebih dulu (state JSON selalu dikirim).
    if (images && Buffer.byteLength(body, "utf8") > DREX_MAX_BODY_BYTES) {
      logger.warn({ bytes: Buffer.byteLength(body, "utf8") }, "DREX_VISION_SKIPPED: body melebihi batas 1 MiB");
      delete payload.images;
      body = JSON.stringify(payload);
    }
    const t0 = Date.now();
    let res: Response;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), Math.max(1, env.DREX_TIMEOUT_MS));
      try {
        res = await this.fetchImpl(this.endpoint(), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            // Key HANYA lewat header; tidak pernah masuk log/error message.
            authorization: `Bearer ${env.DREX_API_KEY}`,
          },
          body,
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      const totalMs = Date.now() - t0;
      const aborted = err instanceof Error && err.name === "AbortError";
      this.logOutcome({ ok: false, code: aborted ? "DREX_TIMEOUT" : "DREX_UNAVAILABLE", totalMs });
      return {
        ok: false,
        code: aborted ? "DREX_TIMEOUT" : "DREX_UNAVAILABLE",
        detail: aborted ? `timeout ${env.DREX_TIMEOUT_MS}ms` : "network error",
        latency: { requestMs: totalMs, responseMs: 0, totalMs },
      };
    }
    const t1 = Date.now();
    let text = "";
    try {
      text = await res.text();
    } catch {
      const totalMs = Date.now() - t0;
      this.logOutcome({ ok: false, code: "DREX_UNAVAILABLE", totalMs, status: res.status });
      return { ok: false, code: "DREX_UNAVAILABLE", detail: "body read failed", latency: { requestMs: t1 - t0, responseMs: Date.now() - t1, totalMs } };
    }
    const t2 = Date.now();
    const latency: DrexLatency = { requestMs: t1 - t0, responseMs: t2 - t1, totalMs: t2 - t0 };
    if (!res.ok) return this.mapHttpError(res, text, latency);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      this.logOutcome({ ok: false, code: "DREX_MALFORMED_RESPONSE", totalMs: latency.totalMs, status: res.status });
      return { ok: false, code: "DREX_MALFORMED_RESPONSE", detail: "body bukan JSON", latency };
    }
    const answers = parseDrexAnswers(json, questions);
    if (!answers) {
      this.logOutcome({ ok: false, code: "DREX_MALFORMED_RESPONSE", totalMs: latency.totalMs, status: res.status });
      return { ok: false, code: "DREX_MALFORMED_RESPONSE", detail: "bentuk answers tidak sesuai kontrak", latency };
    }
    const root = (typeof json === "object" && json !== null ? json : {}) as Record<string, unknown>;
    const data: DrexEvaluateOk = {
      model: typeof root.model === "string" ? root.model : env.DREX_MODEL,
      requestId: typeof root.request_id === "string" ? root.request_id : null,
      evaluationTimeMs: typeof root.evaluation_time_ms === "number" && Number.isFinite(root.evaluation_time_ms) ? root.evaluation_time_ms : null,
      latency,
      answers,
      raw: json,
    };
    this.logOutcome({ ok: true, totalMs: latency.totalMs, status: res.status, requestMs: latency.requestMs, responseMs: latency.responseMs, evaluationTimeMs: data.evaluationTimeMs, requestId: data.requestId, imageCount: images ? images.length : 0 });
    return { ok: true, data };
  }

  private mapHttpError(res: Response, text: string, latency: DrexLatency): DrexResult {
    const code: DrexErrorCode =
      res.status === 429 ? "DREX_RATE_LIMITED"
        : res.status >= 500 ? "DREX_UNAVAILABLE"
          : "DREX_BAD_REQUEST"; // 4xx lain termasuk 422: kesalahan request, jangan retry.
    // Hanya potongan kecil body error (tanpa header/secret) untuk diagnostik;
    // key di-redact defensif bila server memantulkannya kembali.
    const redacted = env.DREX_API_KEY ? text.split(env.DREX_API_KEY).join("[REDACTED]") : text;
    const detail = `HTTP ${res.status}${res.headers.get("retry-after") ? ` retry-after=${res.headers.get("retry-after")}` : ""}: ${redacted.slice(0, 160)}`;
    this.logOutcome({ ok: false, code, totalMs: latency.totalMs, status: res.status });
    return { ok: false, code, detail, latency };
  }

  /** Log ringkas tanpa state, tanpa body penuh, tanpa kredensial (req. latensi). */
  private logOutcome(o: {
    ok: boolean; code?: DrexErrorCode; totalMs: number; status?: number;
    requestMs?: number; responseMs?: number; evaluationTimeMs?: number | null; requestId?: string | null;
    imageCount?: number;
  }): void {
    logger.info(
      {
        status: o.ok ? "ok" : o.code,
        httpStatus: o.status ?? null,
        requestMs: o.requestMs ?? null,
        responseMs: o.responseMs ?? null,
        totalMs: o.totalMs,
        evaluationTimeMs: o.evaluationTimeMs ?? null,
        requestId: o.requestId ?? null,
        imageCount: o.imageCount ?? 0,
        model: env.DREX_MODEL,
      },
      o.ok ? "DREX_EVAL_OK" : "DREX_EVAL_FAIL",
    );
  }
}

export const defaultDrexAdapter = new DrexAdapter();
