// Cross-examine retrospective agent claims against exact database facts.
// Uses only /api/agents/ask; no trading endpoint is called.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const file=resolve('data/audit/agent-roundtable-2026-09-28.json');
const report=JSON.parse(readFileSync(file,'utf8'));
const questions=[
  ['scanner-supervisor','Bima','Klaim Anda: satu kemenangan ARX +1,498R membuktikan edge TREND_FOLLOWING. Itu n=1. Koreksi klaim tersebut; GRASS -1,612R, keseluruhan PAPER PF 0,63. Apa bukti minimal untuk menguji trigger?'],
  ['macro-scout','Vega','Koreksi: EventLog saat entry mencatat macro-scout matrixRow dan PASS, tetapi tidak menyimpan nilai mentah BTC.D/BTC per posisi. Anda mengklaim PF 0,63 dengan dan tanpa PASS padahal tak ada kelompok kontrol. Revisi kesimpulan tanpa counterfactual palsu.'],
  ['setup-judge','Arka','Anda menyebut skor 78/KNN 54% tanpa sumber. Log asli: GRASS skor 68 KNN 0,6; ARX skor 68 KNN 0,4; AERO 72 KNN unknown; semua GO byLlm=false. Akui angka tidak didukung dan jelaskan batas inferensi.'],
  ['risk-officer','Wardha','Koreksi hitungan GRASS: originalRiskUsd=0,923836; netPnL=-1,488867; fee=0,075544; R=-1,611613. Anda menyebut -1,612R = -$1,61 kotor; itu salah. Hitung gross loss dan jelaskan stop fill 0,62888667 vs SL 0,633.'],
  ['trade-supervisor','Nadira','Koreksi: GRASS SL level 0,633, PAPER fill exit 0,62888667; AERO SHORT SL 0,8577, exit 0,85821189. Jadi simulasi tidak selalu fill tepat di stop. Revisi penjelasan gap dan batas bukti live.'],
  ['watchdog','Raksa','Koreksi: ARM OFF tersimpan di Setting dan sudah diuji tetap OFF sesudah restart. Event trade-supervisor memuat positionId dan OrderExec menaut ke positionId; namun snapshot indikator/makro mentah tidak lengkap. Revisi temuan observabilitas.'],
  ['post-mortem','Sesha','Koreksi: 518 orphan adalah LearningEntry tanpa tradeId karena histori pernah di-reset, bukan baris Trade tanpa entry/exit. Tiga PAPER trade punya dua jurnal, tetapi statistik WR/PF dihitung dari Trade sehingga tidak otomatis menggelembung. Apa risiko sebenarnya dari jurnal?'],
  ['backtest-auditor','Varuna','Koreksi istilah: 90 PASSED lama berlabel v0.1.0-base tanpa provenance OOS yang bisa diverifikasi; jangan sebut backtest historis terverifikasi. Latest 0 sample. Apa bukti yang dibutuhkan untuk sertifikasi 500 trade OOS?'],
];
const crosschecks=[];
for (const [agentId,name,question] of questions) {
  try {
    const res=await fetch('http://localhost:8787/api/agents/ask',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({agentId,question:`Audit retrospektif tanpa order. ${question}`}),
      signal:AbortSignal.timeout(70000),
    });
    const data=await res.json();
    if(!res.ok)throw new Error(data.error ?? `HTTP ${res.status}`);
    const row={agentId,name,question,answer:String(data.answer ?? ''),byLlm:data.byLlm===true,failureReason:data.failureReason ?? null};
    crosschecks.push(row);
    process.stdout.write(`${name}: ${row.byLlm ? 'OK' : `UNAVAILABLE ${row.failureReason}`}\n`);
  } catch(error) {
    crosschecks.push({agentId,name,question,answer:'',byLlm:false,failureReason:String(error?.message ?? error)});
    process.stdout.write(`${name}: ERROR\n`);
  }
}
report.crosschecks=crosschecks;
writeFileSync(file,JSON.stringify(report,null,2),'utf8');
process.stdout.write(`Updated ${file}\n`);
