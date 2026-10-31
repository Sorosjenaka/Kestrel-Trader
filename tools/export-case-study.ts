// tools/export-case-study.ts <tradeId> — SMB T-08.
// Render studi kasus teknis satu trade dari DB + klines Binance ke stdout/file.
// Read-only terhadap data trading; tidak menyentuh ARM/posisi.
// Pakai: npx tsx tools/export-case-study.ts 2641 [out.md]
import { db } from "../apps/server/src/core/db.js";
import { prismaLearningRepo } from "../apps/server/src/learning/postMortemEvaluator.js";
import { renderTradeCaseStudy } from "../apps/server/src/learning/caseStudy.js";
import { buildTradeForensicBundle, type ForensicBar } from "../apps/server/src/learning/tradeForensics.js";
import { binanceFuturesClient } from "../apps/server/src/markets/binanceFuturesClient.js";
import fs from "node:fs";

function parseBinanceKlines(rows: unknown[]): ForensicBar[] {
  return rows.flatMap((row) => {
    if (!Array.isArray(row) || row.length < 6) return [];
    const bar = { openTime: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]) };
    return Object.values(bar).every(Number.isFinite) ? [bar] : [];
  });
}

async function main() {
  const id = Number(process.argv[2]);
  if (!Number.isInteger(id) || id <= 0) {
    console.error("Pakai: npx tsx tools/export-case-study.ts <tradeId> [file-output.md]");
    process.exit(2);
  }
  const trade = await prismaLearningRepo.findTradeById(id);
  if (!trade) { console.error(`Trade #${id} tidak ditemukan`); process.exit(1); }
  const learning = await db.learningEntry.findFirst({ where: { tradeId: id }, orderBy: { id: "desc" } });

  const intervalMs = 60_000;
  const openedAt = trade.openedAt?.getTime();
  const closedAt = trade.closedAt?.getTime() ?? trade.createdAt?.getTime();
  let bundle = buildTradeForensicBundle({ trade, interval: "1m", barsBySymbol: {} });
  if (openedAt && closedAt && closedAt > openedAt) {
    const from = Math.floor((openedAt - 14 * intervalMs) / intervalMs) * intervalMs;
    const to = Math.ceil((closedAt + 6 * intervalMs) / intervalMs) * intervalMs;
    const symbols = [...new Set([trade.symbol.toUpperCase(), "BTCUSDT", "ETHUSDT", "BTCDOMUSDT"])];
    const barsBySymbol: Record<string, ForensicBar[]> = {};
    for (const sym of symbols) {
      try { barsBySymbol[sym] = parseBinanceKlines(await binanceFuturesClient.fetchKlinesRange(sym, "1m", from, to, 1000)); }
      catch { barsBySymbol[sym] = []; }
    }
    bundle = buildTradeForensicBundle({ trade, interval: "1m", barsBySymbol });
  }

  const markdown = renderTradeCaseStudy({
    id: trade.id, symbol: trade.symbol, side: trade.side, mode: trade.mode,
    strategyId: trade.strategyId, entryAvg: trade.entryAvg, exitAvg: trade.exitAvg,
    pnlUsd: trade.pnlUsd, rMultiple: trade.rMultiple, feeUsd: trade.feeUsd,
    holdMinutes: trade.holdMinutes, closeReason: trade.closeReason,
    plannedSlPrice: trade.plannedSlPrice, plannedTp1Price: trade.plannedTp1Price,
    executionMistake: learning?.executionMistake ?? null,
    causeCode: learning?.causeCode ?? null,
  }, bundle);

  const out = process.argv[3];
  if (out) { fs.writeFileSync(out, markdown, "utf8"); console.log(`Studi kasus trade #${id} -> ${out}`); }
  else console.log(markdown);
  await db.$disconnect();
}

main().catch((e) => { console.error("ERROR:", (e as Error).message); process.exit(1); });