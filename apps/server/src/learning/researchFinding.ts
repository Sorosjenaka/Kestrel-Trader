// apps/server/src/learning/researchFinding.ts
// Big Brain — jurnal temuan riset ("findings/verdict", 15 Okt 2026).
//
// KONTRAK:
//  - SATU baris per eksperimen riset: hipotesis + referensi bukti (id/hash
//    BacktestRun atau audit) + verdict + keputusan operator. Ini penawar
//    "klaim sudah di-backtest" tanpa bukti angka (lihat memory: 15
//    BacktestRun FAILED NO_DATA tapi diklaim tervalidasi).
//  - Fail-open pada pencatatan, sama dengan decisionLog: kegagalan log
//    tidak boleh menggagalkan riset/trading — tapi error WAJIB ter-log.
//  - operatorDecision hanya diubah lewat decideResearchFinding oleh
//    operator (route /api/research/findings/:id/decision) — LLM tidak
//    berhak meng-ADOPT temuan sendiri (Golden Rule: approval operator).
import { db } from "../core/db.js";
import { logger } from "../core/logger.js";

export type ExperimentType =
  | "BACKTEST"
  | "OOS_VALIDATION"
  | "EVENT_REPLAY"
  | "LOOKAHEAD_AUDIT";
export type FindingVerdict = "SUPPORTIVE" | "REFUTED" | "INCONCLUSIVE";
export type OperatorDecision = "PENDING" | "ADOPTED" | "REJECTED";

export interface FindingRunRef {
  kind: ExperimentType;
  id?: number | null;
  hash?: string | null;
  label?: string;
}

export interface FindingMetrics {
  [key: string]: number | string | boolean | null;
}

export interface ResearchFindingInput {
  title: string;
  hypothesis: string;
  experimentType: ExperimentType;
  verdict: FindingVerdict;
  conclusion?: string;
  runRefs?: FindingRunRef[];
  metrics?: FindingMetrics;
}

const VALID_EXPERIMENT_TYPES: ExperimentType[] = ["BACKTEST", "OOS_VALIDATION", "EVENT_REPLAY", "LOOKAHEAD_AUDIT"];
const VALID_VERDICTS: FindingVerdict[] = ["SUPPORTIVE", "REFUTED", "INCONCLUSIVE"];

/** Tulis satu temuan riset. Kembalikan id (null bila gagal — fail-open). */
export async function logResearchFinding(input: ResearchFindingInput): Promise<number | null> {
  if (!input.title.trim() || !input.hypothesis.trim()) {
    logger.warn({ msg: "ResearchFinding ditolak: title/hypothesis kosong" });
    return null;
  }
  if (!VALID_EXPERIMENT_TYPES.includes(input.experimentType)) {
    logger.warn({ msg: "ResearchFinding ditolak: experimentType tidak valid", experimentType: input.experimentType });
    return null;
  }
  if (!VALID_VERDICTS.includes(input.verdict)) {
    logger.warn({ msg: "ResearchFinding ditolak: verdict tidak valid", verdict: input.verdict });
    return null;
  }
  try {
    const row = await db.researchFinding.create({
      data: {
        title: input.title,
        hypothesis: input.hypothesis,
        experimentType: input.experimentType,
        verdict: input.verdict,
        conclusion: input.conclusion ?? "",
        runRefs: JSON.stringify(input.runRefs ?? []),
        metrics: JSON.stringify(input.metrics ?? {}),
      },
    });
    return row?.id ?? null;
  } catch (e) {
    logger.error({ msg: "ResearchFinding gagal ditulis (fail-open)", error: (e as Error).message });
    return null;
  }
}

/** Daftar temuan terbaru (untuk dashboard & LLM analyst). */
export async function listResearchFindings(limit = 50): Promise<Record<string, unknown>[]> {
  try {
    const rows = await db.researchFinding.findMany({
      orderBy: { id: "desc" },
      take: Math.min(Math.max(1, limit), 200),
    });
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      hypothesis: r.hypothesis,
      experimentType: r.experimentType,
      verdict: r.verdict,
      conclusion: r.conclusion,
      runRefs: safeParse(r.runRefs, []),
      metrics: safeParse(r.metrics, {}),
      operatorDecision: r.operatorDecision,
      decidedAt: r.decidedAt,
      createdAt: r.createdAt,
    }));
  } catch (e) {
    logger.error({ msg: "listResearchFindings gagal (fail-open)", error: (e as Error).message });
    return [];
  }
}

/** Keputusan operator atas satu temuan. Hanya PENDING yang boleh diputuskan. */
export async function decideResearchFinding(
  id: number,
  decision: Exclude<OperatorDecision, "PENDING">
): Promise<boolean> {
  if (decision !== "ADOPTED" && decision !== "REJECTED") return false;
  try {
    const row = await db.researchFinding.findUnique({ where: { id } });
    if (!row) {
      logger.warn({ msg: "decideResearchFinding: temuan tidak ditemukan", id });
      return false;
    }
    if (row.operatorDecision !== "PENDING") {
      logger.warn({ msg: "decideResearchFinding: keputusan sudah final", id, operatorDecision: row.operatorDecision });
      return false;
    }
    await db.researchFinding.update({
      where: { id },
      data: { operatorDecision: decision, decidedAt: new Date() },
    });
    return true;
  } catch (e) {
    logger.error({ msg: "decideResearchFinding gagal (fail-open)", error: (e as Error).message });
    return false;
  }
}

function safeParse(s: string, fallback: unknown): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}
