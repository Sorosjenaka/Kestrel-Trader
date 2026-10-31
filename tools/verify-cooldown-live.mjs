// tools/verify-cooldown-live.mjs — verifikasi cooldown anti-double-entry pakai DB NYATA.
// READ-ONLY. JALANKAN: node tools/verify-cooldown-live.mjs
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { resolveDbPath } from "./db-path.mjs";
const COOLDOWN_WIN_MIN = 30;
const COOLDOWN_LOSS_MIN = 45;
const db = new DatabaseSync(resolveDbPath(), { readOnly: true });
const q = (sql) => db.prepare(sql).all();
const isLoss = (r) => { const s=String(r??"").toUpperCase(); return s==="SL"||s==="TREND_FLIP"||s==="LIQ_GAP"||s==="KILL"; };
const now = Date.now();

// Ambil penutupan TERAKHIR per simbol (persis query bot: CLOSED non-DEMO, closedAt desc)
const closed = q("SELECT symbol, closedAt, closeReason FROM Position WHERE status='CLOSED' AND source!='DEMO' AND closedAt IS NOT NULL ORDER BY closedAt DESC LIMIT 300");
const last = new Map();
for (const c of closed) if (!last.has(c.symbol)) last.set(c.symbol, c);

console.log(`=== COOLDOWN STATUS PER SIMBOL (bandingkan dgn kandidat bot) ===`);
console.log(`window: WIN ${COOLDOWN_WIN_MIN}mnt / LOSS ${COOLDOWN_LOSS_MIN}mnt | now=${new Date(now).toLocaleString("id-ID",{timeZone:"Asia/Jakarta"})}\n`);
let coolingCount = 0;
for (const sym of [...last.keys()].sort()) {
  const c = last.get(sym);
  const loss = isLoss(c.closeReason);
  const win = loss ? COOLDOWN_LOSS_MIN : COOLDOWN_WIN_MIN;
  const elapsed = (now - Number(c.closedAt)) / 60000;
  const remaining = win - elapsed;
  const cooling = remaining > 0;
  if (cooling) coolingCount++;
  console.log(`${cooling ? "DIBLOKIR" : "BOLEH   "} ${sym.padEnd(16)} exit=${String(c.closeReason).padEnd(11)} ${elapsed.toFixed(1)}mnt lalu  sisa=${cooling ? remaining.toFixed(1)+"mnt" : "-"}`);
}
console.log(`\n${coolingCount} simbol sedang cooldown (entry baru diblokir), ${last.size - coolingCount} simbol boleh di-entry.`);
console.log(`OPEN sekarang: ${q("SELECT COUNT(*) c FROM Position WHERE status='OPEN'")[0].c}`);
db.close();
