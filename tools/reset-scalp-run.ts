// tools/reset-scalp-run.ts
// RESET RUN PAPER "SUPER SCALPING" (perintah operator 29 Sep 2026):
//   "reset trading saya balikin balance nya ke 200$ dan hapus history trade
//    yang di mulai dari nomor #1273. serta close posisi yang sedang berjalan."
//
// Urutan (PAPER-only, gagal cepat bila syarat tidak terpenuhi):
//   0) SYNC env file -> proses (tsx watch mewarisi nilai basi; env.ts sudah
//      memaksa file menang, tapi tool ini memanggil ulang agar pasti).
//   1) BACKUP file DB + arsip JSON lengkap (trades/positions/orderExecs/learning).
//   2) DISARM lewat API server (bot berhenti membuka posisi selama reset).
//   3) CLOSE semua posisi OPEN pada MARK FRESH futures (exit realistis, bukan
//      exit palsu di harga entry) -> menghasilkan Trade baru yang ikut diarsipkan.
//   4) PURGE Trade dengan id >= --from-id (default 1273) beserta Position +
//      OrderExec-nya. Trade dari closure langkah 3 juga terhapus karena
//      id-nya >= --from-id; itulah yang membuat saldo kembali persis $200.
//   5) PAPER_RESET di-set ke sekarang -> equity = START_EQUITY_USD = $200.00.
//   6) RE-ARM lewat API server (operator meminta auto arm terus nyalakan).
//   7) Event audit NEW_SCALP_RUN_RESETED ditulis ke EventLog.
//
// Yang DIPERTAHANKAN: LearningEntry (jurnal/otak), EventLog, KNN library file.
// Jalankan: npx tsx tools/reset-scalp-run.ts [--from-id 1273] [--dry-run]
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { db } from "../apps/server/src/core/db.js";
import { env } from "../apps/server/src/core/env.js";
import { START_EQUITY_USD } from "../apps/server/src/risk/riskEngine.js";
import { PAPER_RESET_KEY } from "../apps/server/src/core/paperSession.js";

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? String(argv[i + 1]) : fallback;
};
const FROM_ID = Math.max(1, Math.floor(Number(flag("from-id", "1273")) || 1273));
const DRY_RUN = argv.includes("--dry-run");
const API = `http://127.0.0.1:${env.PORT}`;

async function api(pathname: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${API}${pathname}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (!res.ok) throw new Error(`API ${pathname} -> HTTP ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

/** Mark price futures FRESH (<=30 dtk) langsung dari hub WS server. */
async function freshMarks(symbols: string[]): Promise<Record<string, number>> {
  if (symbols.length === 0) return {};
  const out: Record<string, number> = {};
  const url = `/api/prices/live?symbols=${encodeURIComponent(symbols.join(","))}`;
  const body = await api(url);
  for (const s of symbols) {
    const q = body?.prices?.[s];
    const p = Number(q?.m ?? q?.p ?? 0);
    if (Number.isFinite(p) && p > 0) out[s] = p;
  }
  return out;
}

function dbFilePath(): string | null {
  const url = String(process.env.DATABASE_URL ?? env.DATABASE_URL ?? "");
  const m = url.match(/^file:(.+)$/i);
  if (!m?.[1]) return null;
  return path.isAbsolute(m[1]) ? m[1] : path.resolve(process.cwd(), m[1]);
}

async function main() {
  if (env.BINANCE_EXECUTION_MODE !== "PAPER") {
    throw new Error(`BATAL: tool ini PAPER-only (mode aktif ${env.BINANCE_EXECUTION_MODE})`);
  }

  // ── 1) Snapshot + arsip SEBELUM perubahan apa pun ──
  const [trades, positions, orderExecs, learnings, candidates, settings] = await Promise.all([
    db.trade.findMany({ orderBy: { id: "asc" } }),
    db.position.findMany({ orderBy: { id: "asc" } }),
    db.orderExec.findMany({ orderBy: { id: "asc" } }),
    db.learningEntry.findMany({ orderBy: { id: "asc" } }),
    db.setupCandidate.findMany({ orderBy: { id: "asc" } }),
    db.setting.findMany({ orderBy: { key: "asc" } }),
  ]);
  const open = positions.filter((p) => p.status === "OPEN");
  const doomedTrades = trades.filter((t) => t.id >= FROM_ID);
  const survivingTrades = trades.filter((t) => t.id < FROM_ID);

  console.log(JSON.stringify({
    step: "SNAPSHOT",
    db: dbFilePath(),
    trades: trades.length,
    tradesToDelete: doomedTrades.length,
    tradesKept: survivingTrades.length,
    tradeIdRange: trades.length ? [trades[0]!.id, trades[trades.length - 1]!.id] : null,
    positionsOpen: open.length,
    orderExecs: orderExecs.length,
    learningsKept: learnings.length,
    startingEquityUsd: START_EQUITY_USD,
  }, null, 2));

  if (DRY_RUN) {
    console.log("DRY-RUN: tidak ada perubahan yang ditulis.");
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archiveDir = path.resolve("data", "trade-archive");
  mkdirSync(archiveDir, { recursive: true });
  const backupDir = path.resolve(".backup");
  mkdirSync(backupDir, { recursive: true });
  const dbFile = dbFilePath();
  if (dbFile && existsSync(dbFile)) {
    copyFileSync(dbFile, path.join(backupDir, `artatrade-preset-reset-${stamp}.db`));
  }
  const archiveFile = path.join(archiveDir, `scalp-run-reset-from-${FROM_ID}-${stamp}.json`);
  writeFileSync(archiveFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    reason: "OPERATOR_RESET_SCALP_RUN",
    executionMode: env.BINANCE_EXECUTION_MODE,
    purgedFromTradeId: FROM_ID,
    startingEquityUsd: START_EQUITY_USD,
    counts: {
      trades: trades.length, positions: positions.length, orderExecs: orderExecs.length,
      learnings: learnings.length, setupCandidates: candidates.length,
    },
    trades, positions, orderExecs, learnings, candidates, settings,
  }, null, 1), "utf8");
  console.log(JSON.stringify({ step: "ARCHIVE", archiveFile, dbBackup: dbFile ? path.join(backupDir, `artatrade-preset-reset-${stamp}.db`) : null }, null, 2));

  // ── 2) DISARM: hentikan entry selama reset ──
  await api("/api/guard/arm", { method: "POST", body: JSON.stringify({ armed: false, reason: "SCALP_RUN_RESET" }) });
  console.log(JSON.stringify({ step: "DISARM", armed: false }, null, 2));

  // ── 3) CLOSE posisi OPEN pada mark futures fresh ──
  const marks = await freshMarks([...new Set(open.map((p) => p.symbol))]);
  const missing = open.filter((p) => !(marks[p.symbol] > 0)).map((p) => p.symbol);
  if (missing.length) throw new Error(`BATAL: mark futures belum segar untuk ${missing.join(",")}`);
  const closed: Array<Record<string, unknown>> = [];
  for (const pos of open) {
    const mark = marks[pos.symbol]!;
    await api(`/api/positions/${pos.id}/kill`, { method: "POST", body: JSON.stringify({ exitPrice: mark, reason: "KILL" }) });
    const after = await db.position.findUnique({ where: { id: pos.id }, select: { status: true, pnlUsd: true, closeReason: true } });
    if (after?.status !== "CLOSED") throw new Error(`BATAL: posisi ${pos.id} (${pos.symbol}) tidak CLOSED`);
    closed.push({ id: pos.id, symbol: pos.symbol, side: pos.side, exitMark: mark, pnlUsd: after.pnlUsd, closeReason: after.closeReason });
  }
  console.log(JSON.stringify({ step: "CLOSE_POSITIONS", closed: closed.length, detail: closed }, null, 2));

  // ── 4) PURGE trade >= FROM_ID (+ position & orderExec-nya) ──
  const doomed = await db.trade.findMany({ where: { id: { gte: FROM_ID } }, select: { id: true, positionId: true } });
  const positionIds = [...new Set(doomed.map((t) => t.positionId))];
  const orphanOpen = await db.position.findMany({ where: { status: "OPEN", source: { not: "DEMO" } }, select: { id: true, symbol: true } });
  if (orphanOpen.length) throw new Error(`BATAL: masih ada posisi OPEN (${orphanOpen.map((p) => p.symbol).join(",")})`);

  const delTrades = await db.trade.deleteMany({ where: { id: { gte: FROM_ID } } });
  const delOrders = await db.orderExec.deleteMany({ where: { positionId: { in: positionIds } } });
  const delPositions = await db.position.deleteMany({ where: { id: { in: positionIds } } });
  const delCandidates = await db.setupCandidate.deleteMany({});
  console.log(JSON.stringify({
    step: "PURGE",
    fromTradeId: FROM_ID,
    deleted: { trades: delTrades.count, orderExecs: delOrders.count, positions: delPositions.count, setupCandidates: delCandidates.count },
    learningsKept: await db.learningEntry.count(),
  }, null, 2));

  // ── 5) PAPER_RESET = sekarang -> equity kembali $200 ──
  const resetAt = new Date();
  await db.setting.upsert({ where: { key: PAPER_RESET_KEY }, update: { value: resetAt.toISOString() }, create: { key: PAPER_RESET_KEY, value: resetAt.toISOString() } });
  // Digest evaluasi lama tidak boleh dipakai sebagai ringkasan run baru.
  await db.setting.deleteMany({ where: { key: "evalDigest" } });

  // ── 6) RE-ARM ──
  await api("/api/guard/arm", { method: "POST", body: JSON.stringify({ armed: true, reason: "SCALP_RUN_RESET_REARM" }) });

  const closedTrades = await db.trade.findMany({ where: { source: { not: "DEMO" } } });
  const realized = closedTrades.reduce((a, t) => a + Number(t.pnlUsd ?? 0), 0);
  await db.eventLog.create({
    data: {
      type: "NEW_SCALP_RUN_RESETED",
      severity: "warn",
      payload: JSON.stringify({
        action: "CLOSE_ALL_AND_PURGE_TRADES_FROM_ID",
        purgedFromTradeId: FROM_ID,
        startingEquityUsd: START_EQUITY_USD,
        archiveFile,
        closedPositions: closed,
        deleted: { trades: delTrades.count, orderExecs: delOrders.count, positions: delPositions.count, setupCandidates: delCandidates.count },
        learningsKept: await db.learningEntry.count(),
        paperResetAt: resetAt.toISOString(),
        realizedAfterPurge: Number(realized.toFixed(4)),
        scalpStrategyIds: env.SCALP_STRATEGY_IDS,
        sidewaysEntryAllowed: env.SIDEWAYS_ENTRY_ALLOWED,
        rearmed: true,
      }),
    },
  });

  const remaining = {
    trades: await db.trade.count(),
    positions: await db.position.count(),
    openPositions: await db.position.count({ where: { status: "OPEN" } }),
    orderExecs: await db.orderExec.count(),
    learnings: await db.learningEntry.count(),
  };
  const equity = Number((START_EQUITY_USD + realized).toFixed(2));
  console.log(JSON.stringify({ step: "DONE", remaining, equityUsd: equity, armed: true }, null, 2));
}

main()
  .catch((e) => { console.error("Fatal:", e.message); process.exitCode = 1; })
  .finally(async () => { await db.$disconnect(); });
