// apps/server/tests/thesisArena.test.ts
// Arena Tesis LONG vs SHORT (Arya/Bayu/Ratih) — fokus: penjaga anti-ngawur
// (wajib kutip ref bukti yang ada), anti-looping (ronde-2 tidak boleh berputar),
// gerbang kualitas juri, dan fail-closed saat juri tidak tersedia.
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/core/db.js", () => ({
  db: {
    eventLog: {
      count: vi.fn(async () => 0),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => undefined),
    },
  },
}));

import {
  parseThesis,
  jaccardSimilarity,
  runThesisArena,
  type ThesisArenaInput,
} from "../src/agents/thesisArena.js";
import type { XkiroAdapter } from "../src/agents/llmAdapter.js";
import { db } from "../src/core/db.js";

const evidence = { cvdAllVenuesUsd: -27768312, wallsActive: 12, pocPrice: 80918, breadth1h: 42, signals24h: 87 };

const input: ThesisArenaInput = {
  symbol: "BTCUSDT",
  dayKey: "2026-10-27",
  analysisSummary: "Regime ranging, breadth 42 persen, CVD negatif tapi membaik.",
  evidence,
};

const longThesisJson = (claim: string, round: number) => JSON.stringify({
  side: "LONG",
  claim,
  evidence: [
    { ref: "wallsActive", value: "12", note: `dinding bid aktif menopang harga (ronde ${round})` },
    { ref: "pocPrice", value: "80918", note: "POC sebagai magnet bawah yang menahan koreksi" },
  ],
  invalidation: "close 4H di bawah 80.500 membatalkan struktur higher-low",
  confidence: 72,
});

const shortThesisJson = (claim: string, round: number) => JSON.stringify({
  side: "SHORT",
  claim,
  evidence: [
    { ref: "cvdAllVenuesUsd", value: "-27768312", note: `tekanan jual agregat masih dominan (ronde ${round})` },
    { ref: "breadth1h", value: "42", note: "breadth lemah, reli tidak tersebar" },
  ],
  invalidation: "close 4H di atas 81.200 membatalkan tekanan distribusi",
  confidence: 68,
});

const refereeJson = (winner: "LONG" | "SHORT" | "NONE", longScore = 8, shortScore = 7) => JSON.stringify({
  longScore: { evidence: longScore, falsifiability: longScore, clarity: longScore, novelty: longScore },
  shortScore: { evidence: shortScore, falsifiability: shortScore, clarity: shortScore, novelty: shortScore },
  winner,
  rationale: "Tesis pemenang lebih spesifik dan bisa dibantah oleh harga.",
});

// Ronde 2: klaim DAN kombinasi bukti substantif berbeda dari ronde 1 (bukan
// sekadar ganti angka) — supaya uji NON-looping realistis.
const longR1 = () => longThesisJson("Struktur higher-low utuh dengan dukungan dinding bid tebal menahan koreksi harga", 1);
const longR2 = () => JSON.stringify({
  side: "LONG",
  claim: "Rebound dari POC diiringi delta buyer dominan pada koreksi terakhir sepanjang sesi",
  evidence: [
    { ref: "pocPrice", value: "80918", note: "magnet bawah kuat pada koreksi terakhir" },
    { ref: "breadth1h", value: "42", note: "konfirmasi luas pasar masih parsial" },
  ],
  invalidation: "close 4H di bawah 80.500 membatalkan skenario akumulasi",
  confidence: 75,
  rebuttal: "Tesis SHORT mengabaikan serapan bid di POC.",
});
const shortR1 = () => shortThesisJson("Distribusi berlanjut di value area atas dengan tekanan jual agregat yang dominan", 1);
const shortR2 = () => JSON.stringify({
  side: "SHORT",
  claim: "Reli kehilangan tenaga di sekitar VAH disertai pelemahan partisipasi beli ritel",
  evidence: [
    { ref: "cvdAllVenuesUsd", value: "-27768312", note: "aliran jual agregat bertahan" },
    { ref: "wallsActive", value: "12", note: "dinding tebal menahan reli intraday" },
  ],
  invalidation: "close 4H di atas 81.200 membatalkan skenario distribusi",
  confidence: 70,
  rebuttal: "Tesis LONG bergantung pada satu dukungan saja.",
});

function adapterWith(handlers: { propose?: (round: number, side: string) => string; referee?: () => string }): XkiroAdapter {
  return {
    callFast: vi.fn(async (user: string) => {
      const m = user.match(/Bangun tesis (LONG|SHORT)|Perbaiki tesis (LONG|SHORT)/);
      const side = (m?.[1] ?? m?.[2] ?? "LONG") as "LONG" | "SHORT";
      const round = user.includes("Bangun tesis") ? 1 : 2;
      return { content: handlers.propose ? handlers.propose(round, side) : "" };
    }),
    callReason: vi.fn(async () => ({ content: handlers.referee ? handlers.referee() : "" })),
  } as unknown as XkiroAdapter;
}

describe("thesisArena — parseThesis (anti-ngawur)", () => {
  const refs = new Set(Object.keys(evidence));

  it("menolak tesis yang mengutip ref karangan (tidak ada di peta bukti)", () => {
    const raw = JSON.stringify({
      side: "LONG",
      claim: "Harga akan naik kuat karena dukungan lembaga besar masuk",
      evidence: [{ ref: "whaleInflowFake", value: "999", note: "karangan" }, { ref: "pocPrice", value: "80918" }],
      invalidation: "break di bawah 80.000 membatalkan tesis ini",
      confidence: 80,
    });
    expect(parseThesis(raw, "LONG", refs)).toBeNull();
  });

  it("menolak tesis dengan <2 bukti atau klaim terlalu pendek", () => {
    const oneEvidence = JSON.stringify({
      side: "LONG", claim: "Naik karena struktur dukungan harga yang kuat saat ini",
      evidence: [{ ref: "pocPrice", value: "80918" }],
      invalidation: "break di bawah 80.000 membatalkan tesis ini", confidence: 50,
    });
    expect(parseThesis(oneEvidence, "LONG", refs)).toBeNull();
    const shortClaim = JSON.stringify({
      side: "LONG", claim: "Naik.",
      evidence: [{ ref: "pocPrice", value: "80918" }, { ref: "wallsActive", value: "12" }],
      invalidation: "break di bawah 80.000 membatalkan tesis ini", confidence: 50,
    });
    expect(parseThesis(shortClaim, "LONG", refs)).toBeNull();
  });

  it("menerima tesis sah dengan ref yang benar", () => {
    const t = parseThesis(longThesisJson("Struktur higher-low utuh dengan dukungan dinding bid tebal.", 1), "LONG", refs);
    expect(t).not.toBeNull();
    expect(t!.evidence).toHaveLength(2);
  });
});

describe("thesisArena — jaccardSimilarity (detektor looping)", () => {
  it("teks hampir identik -> similarity tinggi; teks beda -> rendah", () => {
    const a = "struktur higher low utuh dengan dukungan dinding bid tebal menopang";
    expect(jaccardSimilarity(a, a)).toBeGreaterThan(0.9);
    expect(jaccardSimilarity(a, "tekanan jual agregat dominan breadth lemah distribusi")).toBeLessThan(0.2);
  });
});

describe("thesisArena — runThesisArena", () => {
  it("adu tesis 2 ronde, juri memutuskan pemenang, semua agen menulis AGENT_DIALOG", async () => {
    const createMock = db.eventLog.create as ReturnType<typeof vi.fn>;
    createMock.mockClear();
    const adapter = adapterWith({
      propose: (round, side) => side === "LONG" ? (round === 1 ? longR1() : longR2()) : (round === 1 ? shortR1() : shortR2()),
      referee: () => refereeJson("LONG"),
    });

    const res = await runThesisArena(input, adapter);
    expect(res).not.toBeNull();
    expect(res!.status).toBe("USABLE");
    expect(res!.winner).toBe("LONG");
    expect(res!.loopFlags).toHaveLength(0);

    const rows = createMock.mock.calls.map((c: unknown[]) => (c[0] as { data: { type: string; payload: string } }).data);
    expect(rows.some((r) => r.type === "THESIS_ARENA")).toBe(true);
    const dialogs = rows.filter((r) => r.type === "AGENT_DIALOG").map((r) => JSON.parse(r.payload).agentId);
    expect(dialogs.sort()).toEqual(["thesis-long", "thesis-referee", "thesis-short"]);
  });

  it("ANTI-LOOPING: ronde-2 yang berputar-putar ditandai dan tidak bisa menang", async () => {
    const adapter = adapterWith({
      // Ronde 2 mengulang persis ronde 1 (teks sama) -> looping.
      propose: (_round, side) => side === "LONG" ? longR1() : shortR2(),
      referee: () => refereeJson("LONG"),
    });

    const res = await runThesisArena(input, adapter);
    expect(res!.loopFlags).toContain("LONG_THESIS_LOOPING");
    // Pemenang klaim juri = LONG, tapi LONG looping -> tidak USABLE.
    expect(res!.status).not.toBe("USABLE");
    expect(res!.winner).toBeNull();
    expect(res!.reasons).toContain("WINNER_THESIS_LOOPING");
  });

  it("FAIL-CLOSED: juri tidak tersedia -> tesis tidak pernah berstatus USABLE", async () => {
    const adapter = adapterWith({
      propose: (round, side) => side === "LONG" ? (round === 1 ? longR1() : longR2()) : (round === 1 ? shortR1() : shortR2()),
      referee: () => "not-json",
    });

    const res = await runThesisArena(input, adapter);
    expect(res!.status).toBe("REJECT");
    expect(res!.winner).toBeNull();
    expect(res!.reasons).toContain("REFEREE_UNAVAILABLE_OR_MALFORMED");
  });

  it("gerbang kualitas: skor juri di bawah ambang -> REJECTED_LOW_QUALITY", async () => {
    const adapter = adapterWith({
      propose: (round, side) => side === "LONG" ? (round === 1 ? longR1() : longR2()) : (round === 1 ? shortR1() : shortR2()),
      referee: () => refereeJson("LONG", 4, 3),
    });

    const res = await runThesisArena(input, adapter);
    expect(res!.status).toBe("REJECTED_LOW_QUALITY");
    expect(res!.winner).toBeNull();
    expect(res!.reasons).toContain("WINNER_SCORE_BELOW_GATE");
  });

  it("tesis ngawur (ref karangan) membuat sisi gugur, bukan lolos diam-diam", async () => {
    const adapter = adapterWith({
      propose: (_round, side) => side === "LONG"
        ? JSON.stringify({
            side: "LONG", claim: "Harga pasti naik karena semua indikator mendukung penuh",
            evidence: [{ ref: "madeUpRef", value: "123", note: "karangan" }, { ref: "anotherFake", value: "456" }],
            invalidation: "tidak ada, tesis ini pasti benar menurut analisis",
            confidence: 99,
          })
        : shortR1(),
      referee: () => refereeJson("SHORT"),
    });

    const res = await runThesisArena(input, adapter);
    expect(res!.longThesis).toBeNull();
    expect(res!.reasons).toContain("LONG_THESIS_ROUND1_FAILED");
  });
});
