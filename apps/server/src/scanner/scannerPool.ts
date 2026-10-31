import { db } from "../core/db.js";
import { env } from "../core/env.js";
import type { StrategyPlan } from "../strategies/setupStrategies.js";

export interface ScanItemResult<T = any> {
  symbol: string;
  durationMs: number;
  success: boolean;
  data?: T;
  error?: string;
}

export interface CandidateItem {
  symbol: string;
  score: number;
  // 30 Sep 2026 — refactor SCALP-only: mode tunggal.
  mode: "SCALP";
  regime: string;
  zoneScore: number;
  triggerScore: number;
  trendScore: number;
  knnProb?: number | null;
  gatesPass: Record<string, boolean>;
  status: string;
  rejectReason?: string | null;
  /** Metrik anti-sideways dari TF struktur (Choppiness 14 / ADX 14); null = tak terdata. */
  chop?: number | null;
  chopAdx?: number | null;
  /** ATR(14) / close * 100 pada TF struktur (5m SCALP). */
  structureAtrPct?: number | null;
  // ── Big Brain Tahap B2/B3/B4 (14 Okt 2026): fitur persepsi untuk DecisionLog ──
  /** Kaufman Efficiency Ratio (30 bar) TF struktur — null bila bar kurang. */
  er?: number | null;
  /** Status komputasi ER (null = tidak dihitung jalur ini). */
  erStatus?: "OK" | "NO_DATA" | "INSUFFICIENT_SAMPLES" | "FETCH_FAILED" | null;
  /** Jarak close dari POC volume profile (bin 48) — null bila profil kosong. */
  pocDistanceBins?: number | null;
  /** Perubahan Open Interest % ~30 menit (B4, cache TTL 5 menit) — null bila gagal. */
  oiChangePct?: number | null;
  /** Status OI: OK / NO_DATA / INSUFFICIENT_SAMPLES / FETCH_FAILED. */
  oiStatus?: "OK" | "NO_DATA" | "INSUFFICIENT_SAMPLES" | "FETCH_FAILED" | null;
  /** Alasan singkat kenapa OI tidak tersedia (aman ditampilkan). */
  oiReason?: string | null;
  /** Beta terhadap BTC (return log 5m, ≤200 bar) — null bila data kurang. */
  betaBtc?: number | null;
  /** Status beta. */
  betaStatus?: "OK" | "NO_DATA" | "INSUFFICIENT_SAMPLES" | "FETCH_FAILED" | null;
  /** Alasan singkat kenapa beta tidak tersedia. */
  betaReason?: string | null;
  /** Jumlah analog KNN yang dipakai (setelah item netral dibuang). */
  knnN?: number | null;
  /** Label/ alasan KNN: "KNN_POOL_READY" atau "KNN_POOL_<n>_LT_50". */
  knnLabel?: string | null;
  /** Metrik tren TF bias (15m SCALP); wajib valid untuk entry. */
  biasChop?: number | null;
  biasAdx?: number | null;
  biasTrend?: "BULLISH" | "BEARISH" | "NEUTRAL";
  /** Alasan eligibility (CHOP_HIGH / ADX_LOW / ...) bila ada. */
  eligReasons?: string[];
  // ── Mesin setup (T-5.15): rencana strategi + POI dari analisis multi-timeframe ──
  /** Strategi terpilih (S-01/S-02/S-03/S-04/S-05) hasil evaluasi deterministik. */
  strategyId?: string | null;
  strategyName?: string | null;
  entryType?: string | null;
  plan?: StrategyPlan | null;
  /** Semua plan yang dievaluasi (audit kualitas). */
  planCandidates?: { strategyId: string; matched: boolean; quality: number; reasons: string[] }[];
  zoneType?: string | null;
  zoneTop?: number | null;
  zoneBottom?: number | null;
  tfSummary?: string | null;
  /** true bila skor berasal dari analisis klines nyata (bukan heuristik ticker). */
  mtfAnalyzed?: boolean;
  /** Timestamp analisis klines yang dipakai; guard entry menolak analisis basi. */
  mtfAnalyzedAt?: number;
}

export interface CycleMetricRecord {
  cycleId: number;
  mode: "SCALP";
  pairCount: number;
  durationMs: number;
  successCount: number;
  errorCount: number;
  p95SymbolMs: number;
  completedAt: string;
}

export interface ScanView {
  candidates: CandidateItem[];
  scan: {
    cycleMs: number;
    pairs: number;
    concurrency: number;
    refreshedAt: string | null;
    p95CycleMs: number;
    p95PerSymbolMs: number;
    mode: "SCALP";
    nfr01Compliant: boolean;
    historyCount: number;
  };
}

export interface ScannerPoolOptions {
  concurrency?: number;
  scalpIntervalSec?: number;
  historyLimit?: number;
  now?: () => number;
}

export function calculatePercentile(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const p = Math.max(0, Math.min(100, percentile));
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  const index = Math.max(0, Math.min(sorted.length - 1, rank));
  return sorted[index]!;
}

export class ScannerPool {
  private concurrency: number;
  private scalpIntervalSec: number;
  private historyLimit: number;
  private now: () => number;

  private cycleCounter = 0;
  private isCycleRunning = false;
  private activeWorkers = 0;
  private peakWorkers = 0;
  private timer: NodeJS.Timeout | null = null;

  private lastCycleMs = 0;
  private lastPairCount = 0;
  private lastRefreshedAt: string | null = null;
  private lastMode: "SCALP" = "SCALP";
  private lastP95PerSymbolMs = 0;

  private cycleHistory: CycleMetricRecord[] = [];
  private latestCandidates: CandidateItem[] = [];

  constructor(opts: ScannerPoolOptions = {}) {
    this.concurrency = opts.concurrency ?? env.SCAN_CONCURRENCY ?? 50;
    this.scalpIntervalSec = opts.scalpIntervalSec ?? env.SCAN_INTERVAL_SCALP_SEC ?? 60;
    this.historyLimit = opts.historyLimit ?? 20; // NFR-01: pembanding 20 siklus
    this.now = opts.now ?? (() => Date.now());
  }

  getConcurrency(): number {
    return this.concurrency;
  }

  getActiveWorkers(): number {
    return this.activeWorkers;
  }

  getPeakWorkers(): number {
    return this.peakWorkers;
  }

  getHistory(): CycleMetricRecord[] {
    return [...this.cycleHistory];
  }

  getP95CycleMs(): number {
    if (this.cycleHistory.length === 0) return this.lastCycleMs;
    const durations = this.cycleHistory.map((c) => c.durationMs);
    return calculatePercentile(durations, 95);
  }

  isNfr01Compliant(): boolean {
    const p95 = this.getP95CycleMs();
    if (this.lastPairCount > 150) {
      return p95 <= 90_000;
    }
    return p95 <= 45_000;
  }

  /**
   * Eksekusi concurrent worker pool dengan batas concurrency ketat.
   */
  async runPool<T, R>(
    items: T[],
    workerFn: (item: T, index: number) => Promise<R>,
    concurrencyOverride?: number
  ): Promise<ScanItemResult<R>[]> {
    const limit = concurrencyOverride ?? this.concurrency;
    const results: ScanItemResult<R>[] = new Array(items.length);
    let nextIndex = 0;
    this.activeWorkers = 0;
    this.peakWorkers = 0;

    const worker = async (): Promise<void> => {
      while (nextIndex < items.length) {
        const i = nextIndex++;
        const item = items[i]!;
        this.activeWorkers++;
        if (this.activeWorkers > this.peakWorkers) {
          this.peakWorkers = this.activeWorkers;
        }

        const itemStart = this.now();
        const symbol = typeof item === "string" ? item : (item as any)?.symbol ?? `item-${i}`;
        try {
          const res = await workerFn(item, i);
          results[i] = {
            symbol,
            durationMs: this.now() - itemStart,
            success: true,
            data: res,
          };
        } catch (err: any) {
          results[i] = {
            symbol,
            durationMs: this.now() - itemStart,
            success: false,
            error: err?.message || String(err),
          };
        } finally {
          this.activeWorkers--;
        }
      }
    };

    const workerPromises: Promise<void>[] = [];
    const poolSize = Math.min(limit, items.length);
    for (let w = 0; w < poolSize; w++) {
      workerPromises.push(worker());
    }

    await Promise.all(workerPromises);
    return results;
  }

  /**
   * Menjalankan satu siklus scan utuh.
   */
  async scanCycle(
    symbols: string[],
    mode: "SCALP" = "SCALP",
    workerFn?: (symbol: string) => Promise<CandidateItem | null>
  ): Promise<{
    cycleId: number;
    durationMs: number;
    p95SymbolMs: number;
    results: ScanItemResult<CandidateItem | null>[];
    candidates: CandidateItem[];
  }> {
    if (this.isCycleRunning) {
      throw new Error("SCAN_CYCLE_ALREADY_RUNNING");
    }

    this.isCycleRunning = true;
    const cycleStart = this.now();
    const cycleId = ++this.cycleCounter;

    try {
      const defaultWorker = async (_s: string): Promise<CandidateItem | null> => {
        return null;
      };

      const fn = workerFn ?? defaultWorker;
      const results = await this.runPool(symbols, fn);
      const durationMs = this.now() - cycleStart;

      const symbolDurations = results.map((r) => r.durationMs);
      const p95SymbolMs = calculatePercentile(symbolDurations, 95);

      const successCount = results.filter((r) => r.success).length;
      const errorCount = results.filter((r) => !r.success).length;

      const candidates: CandidateItem[] = results
        .filter((r) => r.success && r.data != null)
        .map((r) => r.data as CandidateItem);

      const metric: CycleMetricRecord = {
        cycleId,
        mode,
        pairCount: symbols.length,
        durationMs,
        successCount,
        errorCount,
        p95SymbolMs,
        completedAt: new Date(this.now()).toISOString(),
      };

      this.cycleHistory.push(metric);
      if (this.cycleHistory.length > this.historyLimit) {
        this.cycleHistory.shift();
      }

      this.lastCycleMs = durationMs;
      this.lastPairCount = symbols.length;
      this.lastRefreshedAt = metric.completedAt;
      this.lastMode = mode;
      this.lastP95PerSymbolMs = p95SymbolMs;
      this.latestCandidates = candidates;

      return {
        cycleId,
        durationMs,
        p95SymbolMs,
        results,
        candidates,
      };
    } finally {
      this.isCycleRunning = false;
    }
  }

  async persistCandidates(candidates: CandidateItem[]): Promise<number> {
    if (candidates.length === 0) return 0;
    let count = 0;
    for (const c of candidates) {
      await db.setupCandidate.create({
        data: {
          symbol: c.symbol,
          mode: c.mode,
          score: c.score,
          regime: c.regime,
          zoneScore: c.zoneScore,
          triggerScore: c.triggerScore,
          trendScore: c.trendScore,
          knnProb: c.knnProb ?? null,
          knnN: c.knnN ?? null,
          gatesPass: JSON.stringify(c.gatesPass),
          status: c.status,
          rejectReason: c.rejectReason ?? null,
          strategyId: c.strategyId ?? null,
          strategyName: c.strategyName ?? null,
          entryType: c.entryType ?? null,
          entryPrice: c.plan?.entryPrice ?? null,
          slPrice: c.plan?.slPrice ?? null,
          tp1Price: c.plan?.tp1Price ?? null,
          tp2Price: c.plan?.tp1Price ?? null,
          zoneType: c.zoneType ?? c.plan?.zoneType ?? null,
          zoneTop: c.zoneTop ?? c.plan?.zoneTop ?? null,
          zoneBottom: c.zoneBottom ?? c.plan?.zoneBottom ?? null,
          tfSummary: c.tfSummary ?? c.plan?.tfSummary ?? null,
          planQuality: c.plan?.quality ?? null,
          planNotes: c.plan ? JSON.stringify({ reasons: c.plan.reasons, rr1: c.plan.rr1, slPct: c.plan.slPct }) : null,
        },
      });
      count++;
    }
    return count;
  }

  /**
   * Gabungkan kandidat tambahan ke view aktif (satu pair satu kandidat).
   * Kandidat READY boleh menggantikan WAIT. 30 Sep 2026 — refactor SCALP-only:
   * `preferredMode` dipertahankan sebagai parameter opsional (selalu SCALP).
   */
  mergeCandidates(extra: CandidateItem[], preferredMode?: "SCALP"): number {
    let added = 0;
    const indexBySymbol = new Map(this.latestCandidates.map((c, i) => [c.symbol.toUpperCase(), i] as const));
    for (const c of extra) {
      const key = c.symbol.toUpperCase();
      const index = indexBySymbol.get(key);
      if (index === undefined) {
        indexBySymbol.set(key, this.latestCandidates.length);
        this.latestCandidates.push(c);
        added++;
      } else if (c.status === "READY" && (
        this.latestCandidates[index]?.status !== "READY" ||
        (preferredMode === c.mode && this.latestCandidates[index]?.mode !== preferredMode)
      )) {
        this.latestCandidates[index] = c;
        added++;
      }
    }
    return added;
  }

  getScanView(): ScanView {    return {
      candidates: this.latestCandidates,
      scan: {
        cycleMs: this.lastCycleMs,
        pairs: this.lastPairCount,
        concurrency: this.concurrency,
        refreshedAt: this.lastRefreshedAt,
        p95CycleMs: this.getP95CycleMs(),
        p95PerSymbolMs: this.lastP95PerSymbolMs,
        mode: this.lastMode,
        nfr01Compliant: this.isNfr01Compliant(),
        historyCount: this.cycleHistory.length,
      },
    };
  }

  startScheduler(
    mode: "SCALP" = "SCALP",
    getSymbolsFn: () => Promise<string[]>,
    workerFn?: (symbol: string) => Promise<CandidateItem | null>
  ): void {
    this.stopScheduler();
    const intervalSec = this.scalpIntervalSec;
    const intervalMs = intervalSec * 1000;

    const tick = async () => {
      if (this.isCycleRunning) return;
      try {
        const symbols = await getSymbolsFn();
        await this.scanCycle(symbols, mode, workerFn);
      } catch {
        // Abaikan dan lanjutkan siklus berikutnya
      }
    };

    void tick();
    this.timer = setInterval(tick, intervalMs);
  }

  stopScheduler(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isSchedulerRunning(): boolean {
    return this.timer !== null;
  }

  isScanning(): boolean {
    return this.isCycleRunning;
  }
}

export const scannerPool = new ScannerPool();
