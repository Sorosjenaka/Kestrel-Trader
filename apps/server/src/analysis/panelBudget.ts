// apps/server/src/analysis/panelBudget.ts — 26 Okt 2026 (TAHAP 6B)
//
// BUDGET PANEL = BATAS KERAS.
//
// Aturan:
//  - Budget PANEL terpisah dari budget agen global (yang ada di llmAdapter).
//  - Checksum: sebelum SETIAP request dikirim (termasuk retry 429/5xx), jatah
//    diperiksa. Kalau jatah habis, request TIDAK dikirim (bukan dikirim lalu
//    diabaikan) — jadi tidak ada overshoot antar-batch.
//  - Counter terpisah: attempts (request terkirim), success (analisis LLM
//    berhasil), cacheHit (dilewati), token aktual (dari provider).
//
// Definisi satuan:
//  - "attempt" = satu request HTTP ke provider. Retry 429/5xx menambah attempt.
//  - budget per jam = PANEL_AI_MAX_PER_HOUR (jumlah request HTTP, bukan
//    jumlah analisis) + PANEL_AI_MAX_TOKENS_PER_HOUR (token aktual).

import { LlmBudgetExceededError } from "../agents/llmAdapter.js";

export interface PanelBudgetConfig {
  /** Maks request HTTP per jam untuk panel AI. */
  maxRequestsPerHour: number;
  /** Maks token aktual per jam untuk panel AI (0 = tanpa batas token). */
  maxTokensPerHour: number;
  /** Maks request HTTP per batch analisis (per simbol). */
  maxRequestsPerBatch: number;
}

export interface PanelBudgetState {
  attempts: number;
  success: number;
  cacheHit: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  /** Window jam berjalan (epoch ms). */
  windowStartMs: number;
  /** Request yang DITOLAK budget sebelum dikirim. */
  blockedBeforeSend: number;
  /** Batch yang dibatalkan karena budget habis. */
  batchesAborted: number;
}

export class PanelBudget {
  private state: PanelBudgetState;

  constructor(private cfg: PanelBudgetConfig) {
    this.state = {
      attempts: 0, success: 0, cacheHit: 0, tokens: 0,
      promptTokens: 0, completionTokens: 0,
      windowStartMs: Date.now(), blockedBeforeSend: 0, batchesAborted: 0,
    };
  }

  private rollWindow(now = Date.now()): void {
    if (now - this.state.windowStartMs >= 3_600_000) {
      this.state = {
        attempts: 0, success: 0, cacheHit: 0, tokens: 0,
        promptTokens: 0, completionTokens: 0,
        windowStartMs: now, blockedBeforeSend: 0, batchesAborted: 0,
      };
    }
  }

  getState(): PanelBudgetState {
    this.rollWindow();
    return { ...this.state };
  }

  /** Sisa jatah request jam ini. */
  remainingRequests(): number {
    this.rollWindow();
    return Math.max(0, this.cfg.maxRequestsPerHour - this.state.attempts);
  }

  /** Sisa jatah token jam ini (null = tanpa batas). */
  remainingTokens(): number | null {
    this.rollWindow();
    if (this.cfg.maxTokensPerHour <= 0) return null;
    return Math.max(0, this.cfg.maxTokensPerHour - this.state.tokens);
  }

  /**
   * Guard yang dipanggil SEBELUM setiap request (termasuk retry).
   * Melempar LlmBudgetExceededError = request tidak dikirim.
   */
  guardForBatch(batchRequestIndex: number): (attempt: number) => void {
    return (attempt: number) => {
      void attempt;
      this.rollWindow();
      // (1) Batas per batch: request ke-N dalam batch melebihi jatah batch.
      if (batchRequestIndex >= this.cfg.maxRequestsPerBatch) {
        this.state.blockedBeforeSend += 1;
        this.state.batchesAborted += 1;
        throw new LlmBudgetExceededError(
          `PANEL_BUDGET_BATCH_EXCEEDED: batch ${batchRequestIndex + 1}/${this.cfg.maxRequestsPerBatch}`);
      }
      // (2) Batas per jam: jumlah request (termasuk retry) tidak boleh lewat.
      if (this.state.attempts >= this.cfg.maxRequestsPerHour) {
        this.state.blockedBeforeSend += 1;
        this.state.batchesAborted += 1;
        throw new LlmBudgetExceededError(
          `PANEL_BUDGET_HOURLY_EXCEEDED: ${this.state.attempts}/${this.cfg.maxRequestsPerHour}`);
      }
      // (3) Batas token: hanya bisa diperiksa sebelum request (token belum
      //     diketahui), jadi yang dijaga adalah sisa >= 0 — token aktual
      //     dihitung setelah respons dan memblokir request BERIKUTNYA.
      const remTok = this.remainingTokens();
      if (remTok != null && remTok <= 0) {
        this.state.blockedBeforeSend += 1;
        this.state.batchesAborted += 1;
        throw new LlmBudgetExceededError(
          `PANEL_BUDGET_TOKENS_EXCEEDED: ${this.state.tokens}/${this.cfg.maxTokensPerHour}`);
      }
      // (4) Catat attempt — request ini AKAN dikirim (retry juga dihitung).
      this.state.attempts += 1;
    };
  }

  /** Catat hasil sukses: token aktual dari provider. */
  recordSuccess(usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | null): void {
    this.rollWindow();
    this.state.success += 1;
    if (!usage) return;
    const p = usage.promptTokens ?? 0;
    const c = usage.completionTokens ?? 0;
    const t = usage.totalTokens ?? p + c;
    this.state.promptTokens += p;
    this.state.completionTokens += c;
    this.state.tokens += t;
  }

  /** Analisis dilewati (dedup / stale / budget) — tidak menambah token. */
  recordCacheHit(): void {
    this.rollWindow();
    this.state.cacheHit += 1;
  }
}
