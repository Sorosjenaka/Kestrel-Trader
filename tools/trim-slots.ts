// tools/trim-slots.ts - Rapikan jumlah posisi OPEN agar tidak melebihi batas 20.
import { PrismaClient } from "@prisma/client";
import { resolveDbUrl } from "./db-path.mjs";
const db = new PrismaClient({ datasourceUrl: resolveDbUrl() });
const MAX = 20;

async function main() {
  const open = await db.position.findMany({ where: { status: "OPEN" }, orderBy: { id: "asc" } });
  console.log(`OPEN sekarang = ${open.length} (batas ${MAX})`);
  const excess = open.length - MAX;
  if (excess <= 0) {
    console.log("Tidak ada kelebihan. Selesai.");
    return;
  }
  // Tutup posisi TERBARU (id terbesar) supaya posisi lama yang sudah profit tetap jalan.
  const toClose = open.slice(-excess);
  for (const p of toClose) {
    const fee = Number((p.entryPrice * p.qty * 0.0002 + p.entryPrice * p.qty * 0.0005).toFixed(4));
    const net = Number((Number(p.realizedPnlUsd || 0) - fee).toFixed(4));
    const risk = Math.abs(p.tp1Price - p.entryPrice) * p.qty || 1;
    const r = Number((net / risk).toFixed(4));
    const now = new Date();
    const hold = Math.max(1, Math.round((now.getTime() - p.openedAt.getTime()) / 60000));
    await db.$transaction(async (tx) => {
      await tx.position.update({ where: { id: p.id }, data: { status: "CLOSED", closedAt: now, closeReason: "KILL", pnlUsd: net, pnlR: r } });
      await tx.trade.create({
        data: {
          positionId: p.id, symbol: p.symbol, mode: p.mode, side: p.side,
          riskUsd: Number(risk.toFixed(4)), entryAvg: p.entryPrice, exitAvg: p.entryPrice,
          rMultiple: r, pnlUsd: net, feeUsd: fee, fundingUsd: 0, win: net > 0,
          mfeR: 0, maeR: Math.abs(r), holdMinutes: hold, createdAt: now,
        },
      });
      await tx.eventLog.create({
        data: {
          type: "POSITION_CLOSED", severity: "warn",
          payload: JSON.stringify({ symbol: p.symbol, positionId: p.id, closeReason: "KILL", exitAvg: p.entryPrice, netPnlUsd: net, rMultiple: r, win: net > 0, note: "TRIM_EXCESS_SLOT_OVER_20" }),
        },
      });
    });
    console.log(`  #${p.id} ${p.symbol} ditutup (kelebihan slot) net=$${net}`);
  }
  const after = await db.position.count({ where: { status: "OPEN" } });
  console.log(`OPEN setelah trim = ${after}`);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(async () => { await db.$disconnect(); });
