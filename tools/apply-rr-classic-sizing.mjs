// tools/apply-rr-classic-sizing.mjs
// Terapkan sizing RR klasik ke posisi OPEN:
// 1R loss = $1 (dan boleh $1 lebih sedikit karena kuantisasi stepSize),
// profit target = 2.1667R ($2.17+ pada risiko $1) — policy SCALP tunggal.
// Jalankan dengan --apply untuk commit ke DB.
import pkg from "@prisma/client";
import { resolveDbUrl } from "./db-path.mjs";
const { PrismaClient } = pkg;
const prisma = new PrismaClient({ datasourceUrl: resolveDbUrl() });
const APPLY = process.argv.includes("--apply");

const rows = await prisma.position.findMany({
  where: { status: "OPEN" },
  orderBy: { id: "asc" },
  include: { orders: true },
});

console.log(`=== SIZING RR KLASIK (mode=${APPLY ? "APPLY" : "DRY-RUN"}) ===`);
console.log(`Posisi OPEN: ${rows.length}\n`);

let updated = 0;
for (const p of rows) {
  const r = Math.abs(p.entryPrice - p.slPrice);
  if (!(r > 0)) continue;
  const step = p.quantityStep ?? 1;
  const rawSteps = (1.0 / r) / step;
  const ceilSteps = Math.ceil(rawSteps - 1e-9);
  const prec = (step.toString().split(".")[1] || "").length;
  const newQty = Number((ceilSteps * step).toFixed(prec));
  const newLoss = newQty * r;
  const wantR = 2.1667; // SCALP tunggal (tp1R aktif)
  const tpDist = p.tp1Price ? Math.abs(p.tp1Price - p.entryPrice) : wantR * r;
  const newWin = newQty * tpDist;
  const notional = newQty * p.entryPrice;
  const marginUsd = notional / (p.leverage || 25);

  console.log(
    `#${p.id} ${p.symbol.padEnd(12)} [${p.side}] qty: ${p.qty} -> ${newQty} | loss: $${newLoss.toFixed(3)} | win: $${newWin.toFixed(3)} | margin: $${marginUsd.toFixed(2)}`
  );

  if (APPLY) {
    await prisma.position.update({
      where: { id: p.id },
      data: {
        qty: newQty,
        notional,
        marginUsd,
        originalQty: newQty,
        originalRiskUsd: newLoss,
        riskBudgetUsd: newLoss,
      },
    });

    if (p.orders && p.orders.length > 0) {
      await prisma.orderExec.updateMany({
        where: { positionId: p.id },
        data: {
          qty: newQty,
          filledQty: newQty,
        },
      });
    }
    updated++;
  }
}

console.log(`\nSelesai: ${updated} posisi diperbarui.`);
await prisma.$disconnect();
