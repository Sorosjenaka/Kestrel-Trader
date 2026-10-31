// tools/audit-double-entry.mjs — audit DOUBLE ENTRY: simbol SAMA dibuka berulang
// dalam window waktu singkat, plus simulasi apakah COOLDOWN BARU akan memblokirnya.
// READ-ONLY. JALANKAN: node tools/audit-double-entry.mjs [windowMenit]
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { resolveDbPath } from "./db-path.mjs";
const WIN_MIN = Number(process.argv[2] || 30);
const COOLDOWN_WIN_MIN = 30;
const COOLDOWN_LOSS_MIN = 45;
const db = new DatabaseSync(resolveDbPath(), { readOnly: true });
const q = (sql) => db.prepare(sql).all();
const wib = (ms) => new Date(Number(ms)).toLocaleString("id-ID",{timeZone:"Asia/Jakarta",hour12:true,hour:"2-digit",minute:"2-digit",second:"2-digit"});
const isLoss = (r) => { const s=String(r??"").toUpperCase(); return s==="SL"||s==="TREND_FLIP"||s==="LIQ_GAP"||s==="KILL"; };
const rows = q("SELECT t.id tid,t.symbol,t.strategyId,t.entryAvg,t.exitAvg,t.pnlUsd,t.createdAt,p.openedAt,p.closedAt,p.closeReason,p.status FROM Trade t JOIN Position p ON p.id=t.positionId ORDER BY t.symbol, t.id");
const bySym = new Map();
for (const r of rows) { if(!bySym.has(r.symbol)) bySym.set(r.symbol,[]); bySym.get(r.symbol).push(r); }

let pairs=0, blocked=0, lossSum=0;
console.log(`=== DOUBLE ENTRY (jarak OPEN->OPEN <= ${WIN_MIN} mnt) + SIMULASI COOLDOWN ===\n`);
for (const sym of [...bySym.keys()].sort()) {
  const list = bySym.get(sym);
  for (let i=1;i<list.length;i++) {
    const a=list[i-1], b=list[i];
    const gapMin = (Number(b.openedAt)-Number(a.openedAt))/60000;
    if (gapMin > WIN_MIN) continue;
    pairs++;
    const closeGap = (Number(b.openedAt)-Number(a.closedAt))/60000;
    const win = isLoss(a.closeReason) ? COOLDOWN_LOSS_MIN : COOLDOWN_WIN_MIN;
    const willBlock = closeGap < win;
    if (willBlock) { blocked++; lossSum += Number(b.pnlUsd); }
    console.log(`[${sym}] gap=${gapMin.toFixed(1)}mnt | #${a.tid}->#${b.tid} | exit A=${a.closeReason} (${closeGap.toFixed(1)}mnt sebelum B)`);
    console.log(`   #${a.tid} open=${wib(a.openedAt)} entry=${a.entryAvg} exit=${a.exitAvg} pnl=${a.pnlUsd} ${a.closeReason}`);
    console.log(`   #${b.tid} open=${wib(b.openedAt)} entry=${b.entryAvg} exit=${b.exitAvg} pnl=${b.pnlUsd} ${b.closeReason}`);
    console.log(`   -> cooldown ${win}m: ${willBlock ? "DIBLOKIR ✔ (entry #"+b.tid+" tidak akan terjadi)" : "lolos"}\n`);
  }
}
console.log(`=== RINGKASAN ===`);
console.log(`pasangan rapat (<=${WIN_MIN}mnt): ${pairs}`);
console.log(`yang AKAN DIBLOKIR cooldown: ${blocked}`);
console.log(`total PnL trade pemblokiran: $${lossSum.toFixed(4)} (kerugian yang bisa dihindari)`);
console.log(`\n=== PER SIMBOL (top) ===`);
for (const sym of [...bySym.keys()].sort((a,b)=>bySym.get(b).length-bySym.get(a).length).slice(0,12)) {
  const list = bySym.get(sym);
  let p=0; for (let i=1;i<list.length;i++) if((Number(list[i].openedAt)-Number(list[i-1].openedAt))/60000<=WIN_MIN) p++;
  const pnl = list.reduce((a,r)=>a+Number(r.pnlUsd),0);
  console.log(`${sym}: ${list.length} trade, ${p} pasangan rapat, PnL total $${pnl.toFixed(2)}`);
}
db.close();

