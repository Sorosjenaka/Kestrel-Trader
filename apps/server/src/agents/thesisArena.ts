// apps/server/src/agents/thesisArena.ts
// ARENA TESIS LONG vs SHORT (27 Okt 2026, permintaan operator: "sehabis analis
// ai agent LLM saya masuk arena bertarung dalam membuat thesis long atau short
// dan bertarung dalam membuahkan hasil thesis yang baik dan benar bukannya
// menghasilkan thesis looping yang berkunjung tidak jelas").
//
// Pipeline: [analisis cepat] -> [Arya tesis LONG || Bayu tesis SHORT] paralel
// -> [ronde bantah: masing-masing melihat tesis lawan, maks 2 ronde] ->
// [Ratih juri kualitas] -> VERDICT + gerbang kualitas.
//
// Penjaga ANTI-NGAWUR (deterministik, bukan selera LLM):
//  1. Skema JSON ketat: klaim 20-300 karakter, >=2 bukti, invalidation wajib,
//     confidence 0-100. Gagal parse -> retry 1x -> sisi itu GUGUR.
//  2. SETIAP bukti wajib mengutip ref yang ADA di peta bukti input (angka
//     nyata dari snapshot). Tesis yang mengutip angka karangan tidak lolos.
//  3. ANTI-LOOPING: kesamaan Jaccard (kata) antara tesis ronde-2 dan ronde-1
//     yang sama > 0.75 -> tesis ditandai THESIS_LOOPING, putaran berhenti,
//     sisi itu tidak bisa menang. Tidak ada ronde tak terbatas (maks 2).
//  4. Gerbang juri: pemenang harus skor bukti >=6, falsifiability >=6,
//     kejelasan >=6, dan tanpa flag looping; selain itu REJECTED_LOW_QUALITY.
//  5. Juri gagal/invalid -> status REJECT (fail-closed untuk KUALITAS tesis;
//     tesis sampah tidak boleh lolos karena juri tidak ada).
//
// READ-ONLY: output hanya EventLog + AGENT_DIALOG. TIDAK menyentuh keputusan
// entry/exit (Golden Rule #1) — integrasi ke funnel eksekusi butuh persetujuan
// operator terpisah.
import { defaultLlmAdapter, type XkiroAdapter } from "./llmAdapter.js";
import { ALL_12_AGENTS } from "./agentCatalog.js";
import { db } from "../core/db.js";
import { env } from "../core/env.js";
import { logger } from "../core/logger.js";

export const THESIS_ARENA_EVENT_TYPE = "THESIS_ARENA";

export type ThesisSide = "LONG" | "SHORT";

export interface ThesisEvidence {
  ref: string;
  value: string;
  note?: string;
}

export interface Thesis {
  side: ThesisSide;
  claim: string;
  evidence: ThesisEvidence[];
  invalidation: string;
  confidence: number;
  rebuttal?: string;
}

export interface ThesisArenaInput {
  symbol: string;
  dayKey: string;
  analysisSummary: string;
  /** Peta bukti: ref -> nilai. Tesis HANYA boleh mengutip ref yang ada di sini. */
  evidence: Record<string, string | number>;
}

export interface ThesisScore {
  evidence: number;
  falsifiability: number;
  clarity: number;
  novelty: number;
}

export interface RefereeVerdict {
  longScore: ThesisScore;
  shortScore: ThesisScore;
  winner: ThesisSide | "NONE";
  rationale: string;
}

export interface ThesisArenaResult {
  status: "USABLE" | "REJECTED_LOW_QUALITY" | "REJECT";
  winner: ThesisSide | null;
  longThesis: Thesis | null;
  shortThesis: Thesis | null;
  referee: RefereeVerdict | null;
  loopFlags: string[];
  reasons: string[];
  arenaId: string;
}

const MAX_ROUNDS = 2;
const LOOP_JACCARD_THRESHOLD = 0.75;

const words = (t: string): Set<string> =>
  new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));

/** Kesamaan Jaccard antara dua teks (0..1) — detektor tesis berputar-putar. */
export function jaccardSimilarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter += 1;
  return inter / (wa.size + wb.size - inter);
}

function thesisFingerprint(t: Thesis): string {
  return [t.claim, ...t.evidence.map((e) => `${e.ref} ${e.value} ${e.note ?? ""}`), t.invalidation].join(" ");
}

/** Parse ketat tesis dari output LLM. Null = tidak sah. */
export function parseThesis(raw: string, side: ThesisSide, validRefs: Set<string>): Thesis | null {
  try {
    const clean = raw.trim().replace(/^```json\s*|\s*```$/g, "");
    const p = JSON.parse(clean) as Record<string, unknown>;
    if (String(p.side ?? "").toUpperCase() !== side) return null;
    const claim = String(p.claim ?? "").trim();
    if (claim.length < 20 || claim.length > 300) return null;
    const rawEvidence = Array.isArray(p.evidence) ? (p.evidence as unknown[]) : [];
    const evidence: ThesisEvidence[] = [];
    for (const item of rawEvidence) {
      const e = item as Record<string, unknown>;
      const ref = String(e.ref ?? "").trim();
      // ANTI-NGAWUR: ref wajib terdaftar di peta bukti input.
      if (!ref || !validRefs.has(ref)) return null;
      const value = String(e.value ?? "").trim();
      if (!value) return null;
      evidence.push({ ref, value, note: String(e.note ?? "").trim().slice(0, 200) || undefined });
    }
    if (evidence.length < 2) return null;
    const invalidation = String(p.invalidation ?? "").trim();
    if (invalidation.length < 10) return null;
    const confidence = Number(p.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) return null;
    const rebuttal = String(p.rebuttal ?? "").trim().slice(0, 400);
    return { side, claim, evidence, invalidation, confidence, rebuttal: rebuttal || undefined };
  } catch {
    return null;
  }
}

function thesisSystemPrompt(agentId: string, side: ThesisSide, round: number, hasOpponent: boolean): string {
  const profile = ALL_12_AGENTS[agentId];
  return `You are ${profile?.name ?? agentId} (${agentId}), ${profile?.role ?? "thesis advocate"} on the Private Trade AI team.\n` +
    `Personality: ${profile?.personality ?? "evidence-based"}.\n` +
    (hasOpponent
      ? `This is REBUTTAL ROUND ${round}: you see your previous thesis and the opponent's thesis. Refine your thesis with NEW specific evidence and a short rebuttal of the opponent. Do NOT repeat your previous wording.\n`
      : `This is PROPOSAL ROUND ${round}: build the best ${side} thesis.\n`) +
    `Rules: every evidence item MUST cite a ref key that exists in the provided evidence map (no invented numbers). ` +
    `Return JSON only: {"side":"${side}","claim":"specific thesis, 20-300 chars","evidence":[{"ref":"<key from evidence map>","value":"<the number>","note":"why it matters"}],"invalidation":"<price/condition that kills this thesis>","confidence":0-100${hasOpponent ? ',"rebuttal":"<short rebuttal of opponent thesis>"' : ""}}.`;
}

function thesisUserPrompt(input: ThesisArenaInput, side: ThesisSide, round: number, own: Thesis | null, opponent: Thesis | null): string {
  const base = [
    `Symbol: ${input.symbol} (dayKey ${input.dayKey})`,
    `Ringkasan analisis tim: ${input.analysisSummary}`,
    `Peta bukti (ref -> nilai, HANYA boleh mengutip ref ini): ${JSON.stringify(input.evidence)}`,
  ].join("\n");
  if (round === 1) return `${base}\nBangun tesis ${side} terbaik.`;
  return [
    base,
    `Tesis Anda ronde 1: ${own ? JSON.stringify(own) : "(gagal)"}`,
    `Tesis lawan ronde 1: ${opponent ? JSON.stringify(opponent) : "(gagal)"}`,
    `Perbaiki tesis ${side} Anda dengan bukti SPESIFIK BARU dan bantah tesis lawan. Jangan mengulang kalimat ronde 1.`,
  ].join("\n");
}

async function proposeThesis(
  agentId: string,
  input: ThesisArenaInput,
  side: ThesisSide,
  round: number,
  own: Thesis | null,
  opponent: Thesis | null,
  adapter: XkiroAdapter,
): Promise<Thesis | null> {
  const system = thesisSystemPrompt(agentId, side, round, round > 1);
  const user = thesisUserPrompt(input, side, round, own, opponent);
  const validRefs = new Set(Object.keys(input.evidence));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await adapter.callFast(user, system, {
        maxTokens: 700,
        timeoutMs: 25_000,
        queuePriority: "normal",
        queueDeadlineMs: 60_000,
      });
      const parsed = parseThesis(res.content, side, validRefs);
      if (parsed) return parsed;
    } catch (err) {
      logger.warn({ agentId, side, round, err: (err as Error)?.message }, "THESIS_PROPOSAL_FAIL");
    }
  }
  return null;
}

function clampScore(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(0, Math.min(10, v)) : 0;
}

function parseReferee(raw: string): RefereeVerdict | null {
  try {
    const clean = raw.trim().replace(/^```json\s*|\s*```$/g, "");
    const p = JSON.parse(clean) as Record<string, unknown>;
    const ls = (p.longScore ?? p.long_score) as Record<string, unknown> | undefined;
    const ss = (p.shortScore ?? p.short_score) as Record<string, unknown> | undefined;
    if (!ls || !ss) return null;
    const winner = String(p.winner ?? "").toUpperCase();
    if (winner !== "LONG" && winner !== "SHORT" && winner !== "NONE") return null;
    return {
      longScore: {
        evidence: clampScore(ls.evidence),
        falsifiability: clampScore(ls.falsifiability),
        clarity: clampScore(ls.clarity),
        novelty: clampScore(ls.novelty),
      },
      shortScore: {
        evidence: clampScore(ss.evidence),
        falsifiability: clampScore(ss.falsifiability),
        clarity: clampScore(ss.clarity),
        novelty: clampScore(ss.novelty),
      },
      winner,
      rationale: String(p.rationale ?? "").trim().slice(0, 500),
    };
  } catch {
    return null;
  }
}

/**
 * Satu sesi arena tesis TANPA gerbang interval/cap — untuk dipanggil langsung
 * dari funnel entry (opsi B, persetujuan operator 27 Okt). Fail-open untuk LOG,
 * fail-closed untuk KUALITAS: tesis yang tidak lolos skema/looping/gerbang juri
 * tidak pernah berstatus USABLE.
 */
export async function runThesisArenaSession(
  input: ThesisArenaInput,
  adapter: XkiroAdapter = defaultLlmAdapter,
): Promise<ThesisArenaResult | null> {
  const arenaId = `${input.symbol}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  try {
    const reasons: string[] = [];
    const loopFlags: string[] = [];

    // Ronde 1: dua advokat beradu PARALEL.
    let longThesis = await proposeThesis("thesis-long", input, "LONG", 1, null, null, adapter);
    let shortThesis = await proposeThesis("thesis-short", input, "SHORT", 1, null, null, adapter);
    const longR1 = longThesis;
    const shortR1 = shortThesis;
    if (!longThesis) reasons.push("LONG_THESIS_ROUND1_FAILED");
    if (!shortThesis) reasons.push("SHORT_THESIS_ROUND1_FAILED");

    // Ronde 2 (bantah + perbaiki) hanya bila kedua sisi punya tesis; penjaga
    // anti-looping membandingkan dengan ronde-1 sisi yang sama.
    if (longThesis && shortThesis && MAX_ROUNDS >= 2) {
      const [long2, short2] = await Promise.all([
        proposeThesis("thesis-long", input, "LONG", 2, longR1, shortR1, adapter),
        proposeThesis("thesis-short", input, "SHORT", 2, shortR1, longR1, adapter),
      ]);
      if (long2) {
        const sim = jaccardSimilarity(thesisFingerprint(longR1!), thesisFingerprint(long2));
        if (sim > LOOP_JACCARD_THRESHOLD) {
          loopFlags.push("LONG_THESIS_LOOPING");
          longThesis = longR1;
        } else {
          longThesis = long2;
        }
      }
      if (short2) {
        const sim = jaccardSimilarity(thesisFingerprint(shortR1!), thesisFingerprint(short2));
        if (sim > LOOP_JACCARD_THRESHOLD) {
          loopFlags.push("SHORT_THESIS_LOOPING");
          shortThesis = shortR1;
        } else {
          shortThesis = short2;
        }
      }
    }

    // Juri kualitas (Ratih). Gagal/invalid -> fail-closed (REJECT).
    let referee: RefereeVerdict | null = null;
    if (longThesis && shortThesis) {
      const profile = ALL_12_AGENTS["thesis-referee"];
      const system = `You are ${profile?.name ?? "Ratih"} (thesis-referee), ${profile?.role ?? "thesis quality judge"} on the Private Trade AI team.\n` +
        `Judge ONLY thesis quality: evidence strength, falsifiability, clarity, novelty (non-repetitive). ` +
        `Return JSON only: {"longScore":{"evidence":0-10,"falsifiability":0-10,"clarity":0-10,"novelty":0-10},"shortScore":{...},"winner":"LONG|SHORT|NONE","rationale":"brief"}.`;
      const user = `Tesis LONG: ${JSON.stringify(longThesis)}\nTesis SHORT: ${JSON.stringify(shortThesis)}\n` +
        `Peta bukti: ${JSON.stringify(input.evidence)}\n${loopFlags.length ? `Catatan: ${loopFlags.join(", ")}.\n` : ""}Nilai kedua tesis.`;
      try {
        const res = await adapter.callReason(user, system, {
          maxTokens: 800,
          timeoutMs: 40_000,
          queuePriority: "normal",
          queueDeadlineMs: 90_000,
        });
        referee = parseReferee(res.content);
      } catch (err) {
        logger.warn({ arenaId, err: (err as Error)?.message }, "THESIS_REFEREE_FAIL");
      }
      if (!referee) reasons.push("REFEREE_UNAVAILABLE_OR_MALFORMED");
    }

    // Gerbang kualitas akhir.
    let status: ThesisArenaResult["status"] = "REJECT";
    let winner: ThesisSide | null = null;
    if (referee && longThesis && shortThesis) {
      const claimed = referee.winner === "NONE" ? null : referee.winner;
      const score = claimed === "LONG" ? referee.longScore : claimed === "SHORT" ? referee.shortScore : null;
      const looped = claimed ? loopFlags.some((f) => f.startsWith(claimed)) : true;
      if (!claimed) {
        reasons.push("NO_WINNER_BY_REFEREE");
      } else if (looped) {
        reasons.push("WINNER_THESIS_LOOPING");
      } else if (score && (score.evidence < 6 || score.falsifiability < 6 || score.clarity < 6)) {
        status = "REJECTED_LOW_QUALITY";
        winner = null;
        reasons.push("WINNER_SCORE_BELOW_GATE");
      } else {
        status = "USABLE";
        winner = claimed;
      }
    }

    const decision: ThesisArenaResult = {
      status, winner, longThesis, shortThesis, referee, loopFlags, reasons, arenaId,
    };

    await db.eventLog.create({
      data: {
        type: THESIS_ARENA_EVENT_TYPE,
        severity: status === "USABLE" ? "info" : "warn",
        payload: JSON.stringify({ ...decision, symbol: input.symbol, dayKey: input.dayKey, generatedAt: new Date().toISOString() }),
      },
    }).catch((err) => logger.error({ arenaId, err: (err as Error)?.message }, "THESIS_ARENA_LOG_FAIL"));

    // Bukti kartu agen: satu AGENT_DIALOG per penghuni arena.
    for (const [agentId, text] of [
      ["thesis-long", longThesis ? `Tesis LONG: ${longThesis.claim} (yakin ${longThesis.confidence}). Batal bila ${longThesis.invalidation}.` : "Tesis LONG gugur (skema tidak sah)."],
      ["thesis-short", shortThesis ? `Tesis SHORT: ${shortThesis.claim} (yakin ${shortThesis.confidence}). Batal bila ${shortThesis.invalidation}.` : "Tesis SHORT gugur (skema tidak sah)."],
      ["thesis-referee", referee ? `Vonis: ${status}, pemenang ${winner ?? "NONE"}. ${referee.rationale}` : `Vonis: ${status} — juri tidak tersedia, tesis tidak lolos kualitas.`],
    ] as const) {
      const profile = ALL_12_AGENTS[agentId];
      await db.eventLog.create({
        data: {
          type: "AGENT_DIALOG",
          severity: "info",
          payload: JSON.stringify({
            agentId,
            name: profile?.name ?? agentId,
            text,
            timestamp: new Date().toISOString(),
            context: { kind: "thesis_arena", arenaId, symbol: input.symbol, status, winner, loopFlags },
          }),
        },
      }).catch(() => undefined);
    }

    logger.info({ arenaId, status, winner, loopFlags, reasons }, "THESIS_ARENA_DONE");
    return decision;
  } catch (err) {
    logger.info({ arenaId, err: err instanceof Error ? err.message : String(err) }, "THESIS_ARENA_SKIPPED");
    return null;
  }
}

/**
 * Satu sesi arena tesis dengan gerbang interval + cap harian (env THESIS_ARENA_*).
 * Dipakai pipeline riset (setelah analisis). Return null bila dilewati.
 */
export async function runThesisArena(
  input: ThesisArenaInput,
  adapter: XkiroAdapter = defaultLlmAdapter,
): Promise<ThesisArenaResult | null> {
  if (!env.THESIS_ARENA_ENABLED) return null;
  try {
    const dayStart = new Date(`${input.dayKey}T00:00:00.000Z`);
    const [usedToday, lastRow] = await Promise.all([
      db.eventLog.count({ where: { type: THESIS_ARENA_EVENT_TYPE, createdAt: { gte: dayStart } } }).catch(() => 0),
      db.eventLog.findFirst({
        where: { type: THESIS_ARENA_EVENT_TYPE },
        orderBy: { id: "desc" },
        select: { createdAt: true },
      }).catch(() => null),
    ]);
    if (usedToday >= env.THESIS_ARENA_MAX_DAILY_CALLS) return null;
    if (lastRow?.createdAt && Date.now() - lastRow.createdAt.getTime() < env.THESIS_ARENA_INTERVAL_HOURS * 3_600_000) return null;
    return await runThesisArenaSession(input, adapter);
  } catch (err) {
    logger.info({ err: err instanceof Error ? err.message : String(err) }, "THESIS_ARENA_SKIPPED");
    return null;
  }
}
