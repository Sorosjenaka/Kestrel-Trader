// tools/probe-open-positions-rr.mjs
// Baca posisi OPEN di DB live: cek TP1/TP2 vs konvensi RR klasik baru
// (SCALP 2.1667R, single target -> tp2Price == tp1Price).
import pkg from "@prisma/client";
import { resolveDbUrl } from "./db-path.mjs";
const { PrismaClient } = pkg;
const prisma = new PrismaClient({ datasourceUrl: resolveDbUrl() });
const rows = await prisma.position.findMany({
  where: { status: "OPEN" },
  select: { id: true, symbol: true, side: true, mode: true, entryPrice: true, slPrice: true,
    tp1Price: true, tp2Price: true, qty: true, originalQty: true, beMoved: true,
    tp1FilledAt: true, tp2FilledAt: true, source: true },
  orderBy: { id: "asc" },
});
console.log("OPEN positions:", rows.length);
for (const p of rows) {
  const r = Math.abs(p.entryPrice - p.slPrice);
  const wantR = 2.1667; // SCALP tunggal (tp1R aktif)
  const wantTp = p.side === "LONG" ? p.entryPrice + wantR * r : p.entryPrice - wantR * r;
  const tp1R = r > 0 ? Math.abs(p.tp1Price - p.entryPrice) / r : 0;
  const tp2R = r > 0 ? Math.abs(p.tp2Price - p.entryPrice) / r : 0;
  console.log(JSON.stringify({
    id: p.id, symbol: p.symbol, side: p.side, mode: p.mode, source: p.source,
    entry: p.entryPrice, sl: p.slPrice, tp1: p.tp1Price, tp2: p.tp2Price,
    tp1R: Number(tp1R.toFixed(3)), tp2R: Number(tp2R.toFixed(3)),
    wantR, wantTp: Number(wantTp.toFixed(8)),
    tpMatches: Math.abs(p.tp2Price - wantTp) < 1e-8,
    tp2EqTp1: p.tp2Price === p.tp1Price, beMoved: p.beMoved,
    tp1Filled: p.tp1FilledAt !== null, tp2Filled: p.tp2FilledAt !== null,
    qty: p.qty, originalQty: p.originalQty,
  }));
}
await prisma.$disconnect();