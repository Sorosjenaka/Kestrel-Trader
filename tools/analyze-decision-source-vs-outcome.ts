// tools/analyze-decision-source-vs-outcome.ts
// READ-ONLY: atribusi tiap trade CLOSED ke sumber keputusan judge (drex / xkiro / deterministic)
// lalu bandingkan winrate & avgR per sumber. Tidak mengubah kode runtime, posisi, ARM, atau config.
// Cara: npx tsx tools/analyze-decision-source-vs-outcome.ts
import pkg from "@prisma/client";
import { resolveDbUrl } from "./db-path.mjs";
const { PrismaClient } = pkg;

type Src = "drex" | "xkiro" | "deterministic" | "unknown";

interface JudgeEvent {
  symbol: string;
  ts: number; // ms epoch dari payload.timestamp
  decisionSource: Src;
  verdict: string;
}

async function main() {
  const db = new PrismaClient({ datasourceUrl: resolveDbUrl() });

  // 1) Ambil semua dialog setup-judge yang membawa decisionSource + symbol.
  const rows = await db.eventLog.findMany({
    where: {
      type: "AGENT_DIALOG",
      payload: { contains: "setup-judge" },
    },
    orderBy: { id: "asc" },
    select: { payload: true },
  });

  // Ada 2 bentuk payload dialog judge:
  //  A) context lengkap: punya decisionSource, TAPI tanpa symbol (symbol hanya ada di teks)
  //  B) ringkas: punya context.symbol, tanpa decisionSource (sumber disimpulkan dari teks "DREX"/byLlm)
  // Ekstraksi: symbol dari context.symbol ATAU regex USDT pertama di teks; sumber dari
  // context.decisionSource ATAU heuristik teks (Drex disebut -> drex; byLlm -> xkiro; selain -> deterministic).
  const SYM_RE = /\b([A-Z0-9]{2,15}USDT)\b/;
  const bySymbol = new Map<string, JudgeEvent[]>();
  let parsed = 0, noSymbol = 0;
  for (const r of rows) {
    let p: any;
    try { p = JSON.parse(r.payload); } catch { continue; }
    const ctx = p?.context;
    if (!ctx || typeof ctx !== "object") continue;
    const verdict = typeof ctx.verdict === "string" ? ctx.verdict : "";
    if (verdict !== "GO" && verdict !== "NO-GO") continue;
    const text = typeof p.text === "string" ? p.text : "";
    const reason = typeof ctx.reason === "string" ? ctx.reason : "";
    let symbol = typeof ctx.symbol === "string" ? ctx.symbol : "";
    if (!symbol) {
      const m = text.match(SYM_RE) ?? reason.match(SYM_RE);
      if (m) symbol = m[1];
    }
    if (!symbol) { noSymbol++; continue; }
    let src: Src;
    if (ctx.decisionSource === "drex" || ctx.decisionSource === "xkiro" || ctx.decisionSource === "deterministic") {
      src = ctx.decisionSource as Src;
    } else if (/drex/i.test(reason) || /drex/i.test(text)) {
      src = "drex";
    } else if (ctx.byLlm === true) {
      src = "xkiro";
    } else {
      src = "deterministic";
    }
    const ts = Date.parse(p.timestamp);
    if (!Number.isFinite(ts)) continue;
    parsed++;
    const arr = bySymbol.get(symbol) ?? [];
    arr.push({ symbol, ts, decisionSource: src, verdict });
    bySymbol.set(symbol, arr);
  }
  console.log(`[info] dialog tanpa symbol terlewat: ${noSymbol}`);

  // 2) Ambil semua trade, saring yang CLOSED (win sudah terisi) di JS — jumlah kecil.
  const allTrades = await db.trade.findMany({
    select: {
      id: true, symbol: true, side: true, strategyId: true,
      win: true, rMultiple: true, pnlUsd: true, createdAt: true, positionId: true,
    },
  });
  const trades = allTrades.filter((t) => t.win !== null);
  const posIds = Array.from(new Set(trades.map((t) => t.positionId).filter(Boolean)));
  const positions = await db.position.findMany({
    where: { id: { in: posIds as number[] } },
    select: { id: true, openedAt: true },
  });
  const openedAtById = new Map<number, Date>(positions.map((p) => [p.id, p.openedAt]));

  // 3) Atribusi: event GO terakhir untuk simbol yang sama SEBELUM openedAt (<= 20 menit).
  const WINDOW_MS = 20 * 60_000;
  function attribute(symbol: string, openMs: number): Src {
    const arr = bySymbol.get(symbol);
    if (!arr) return "unknown";
    let best: JudgeEvent | null = null;
    for (const e of arr) {
      if (e.verdict !== "GO") continue;
      if (e.ts > openMs) continue;
      if (openMs - e.ts > WINDOW_MS) continue;
      if (!best || e.ts > best.ts) best = e;
    }
    return best ? best.decisionSource : "unknown";
  }

  const agg = new Map<Src, { n: number; w: number; sumR: number; sumPnl: number }>();
  let covered = 0;
  for (const t of trades) {
    const open = openedAtById.get(t.positionId as number);
    const openMs = open ? open.getTime() : t.createdAt.getTime();
    const src = attribute(t.symbol, openMs);
    if (src !== "unknown") covered++;
    const a = agg.get(src) ?? { n: 0, w: 0, sumR: 0, sumPnl: 0 };
    a.n++; if (t.win) a.w++;
    a.sumR += t.rMultiple ?? 0; a.sumPnl += t.pnlUsd ?? 0;
    agg.set(src, a);
  }

  console.log(`judge events dengan decisionSource+symbol: ${parsed} (dari ${rows.length} dialog setup-judge)`);
  console.log(`trade closed dianalisis: ${trades.length}; ter-atribusi: ${covered} (${(100 * covered / Math.max(1, trades.length)).toFixed(1)}%)`);
  console.log("\nSUMBER      N    WIN   WR%    avgR      netUsd");
  for (const k of ["drex", "xkiro", "deterministic", "unknown"] as Src[]) {
    const a = agg.get(k);
    if (!a) { console.log(`${k.padEnd(11)} 0    -     -      -         -`); continue; }
    const wr = a.n ? (100 * a.w / a.n).toFixed(1) : "-";
    const avgR = a.n ? (a.sumR / a.n).toFixed(3) : "-";
    console.log(`${k.padEnd(11)} ${String(a.n).padStart(3)}  ${String(a.w).padStart(3)}  ${wr.padStart(5)}  ${avgR.padStart(7)}  ${a.sumPnl.toFixed(3)}`);
  }

  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });