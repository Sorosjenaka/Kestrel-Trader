// Read-only trade evidence + retrospective questions to the bot's 12 existing
// agents. /api/agents/ask writes their answers to EventLog; it does not arm,
// open/close positions, or mutate strategy settings.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { resolveDbPath } from "./db-path.mjs";

const db = new DatabaseSync(resolveDbPath(), { readOnly: true });
const one = (sql, ...params) => db.prepare(sql).get(...params);
const all = (sql, ...params) => db.prepare(sql).all(...params);
const metric = (where = "source='PAPER_AI'") => {
  const rows = all(`SELECT pnlUsd, feeUsd, rMultiple, win, strategyId FROM Trade WHERE ${where}`);
  const wins = rows.filter(x => x.pnlUsd > 0);
  const losses = rows.filter(x => x.pnlUsd < 0);
  const sum = xs => xs.reduce((a, x) => a + x, 0);
  const net = sum(rows.map(x => x.pnlUsd));
  const fee = sum(rows.map(x => x.feeUsd));
  const grossWin = sum(wins.map(x => x.pnlUsd));
  const grossLoss = -sum(losses.map(x => x.pnlUsd));
  return {
    closed: rows.length, wins: wins.length, winratePct: rows.length ? 100*wins.length/rows.length : null,
    netUsd: net, grossBeforeFeesUsd: net+fee, simulatedFeesUsd: fee,
    profitFactor: grossLoss ? grossWin/grossLoss : null,
    avgNetR: rows.length ? sum(rows.map(x => x.rMultiple))/rows.length : null,
    avgWinUsd: wins.length ? grossWin/wins.length : null,
    avgLossUsd: losses.length ? grossLoss/losses.length : null,
  };
};
const caseIds = [1033, 1043, 1045, 1039];
const cases = caseIds.map(id => {
  const row = one(`SELECT t.id tradeId,t.positionId,t.symbol,t.mode,t.side,t.strategyId,
    t.pnlUsd,t.rMultiple,t.feeUsd,t.fundingUsd,t.mfeR,t.maeR,t.holdMinutes,
    t.accountingQuality,t.fundingVerified,t.excursionsVerified,
    p.openedAt,p.closedAt,p.entryPrice,p.originalSlPrice,p.slPrice,p.tp1Price,p.tp2Price,
    p.originalQty,p.originalRiskUsd,p.closeReason,p.beMoved,p.tp1FilledAt,p.outlookText
    FROM Trade t JOIN Position p ON p.id=t.positionId WHERE t.id=? AND t.source='PAPER_AI'`, id);
  if (!row) return null;
  const fills = all(`SELECT type,side,qty,filledQty,fillPrice,feeUsd,feeEstimated,simulated,reduceOnly,filledAt
    FROM OrderExec WHERE positionId=? ORDER BY id`, row.positionId);
  const candidate = one(`SELECT id,createdAt,score,regime,zoneScore,triggerScore,trendScore,
    knnProb,gatesPass,status,strategyId,planQuality,planNotes,entryPrice,slPrice
    FROM SetupCandidate WHERE symbol=? AND createdAt BETWEEN ? AND ?
    ORDER BY ABS(createdAt-?) LIMIT 1`, row.symbol, row.openedAt-180000, row.openedAt+30000, row.openedAt);
  const lessons = all(`SELECT causeCode,outcome,narrative,lesson FROM LearningEntry WHERE tradeId=? ORDER BY id DESC LIMIT 2`, id);
  const decisions = all(`SELECT createdAt,payload FROM EventLog WHERE type='AGENT_DIALOG'
    AND createdAt BETWEEN ? AND ? AND payload LIKE ? ORDER BY id DESC LIMIT 12`,
    row.openedAt-120000, row.openedAt+30000, `%${row.symbol}%`).map(x => {
      try { const d=JSON.parse(x.payload); return {at:x.createdAt,agentId:d.agentId,text:d.text,context:d.context}; }
      catch { return {at:x.createdAt,text:x.payload}; }
    }).filter(x => ['setup-judge','risk-officer','macro-scout'].includes(x.agentId)).slice(0,6);
  return {...row,fills,candidate,lessons,decisions};
}).filter(Boolean);
const snapshot = {
  capturedAt: new Date().toISOString(),
  kind: 'retrospective PAPER simulation; no new orders',
  paper: metric(), s06: metric("source='PAPER_AI' AND strategyId='S-03'"),
  s04: metric("source='PAPER_AI' AND strategyId='S-04'"),
  legacy: metric("source='LIVE_AI'"),
  learning: {
    paperTradesWithLesson: one(`SELECT COUNT(*) n FROM Trade t WHERE source='PAPER_AI' AND EXISTS (SELECT 1 FROM LearningEntry l WHERE l.tradeId=t.id)`).n,
    orphanLessons: one('SELECT COUNT(*) n FROM LearningEntry WHERE tradeId IS NULL').n,
    activeParameterVersions: one("SELECT COUNT(*) n FROM ParameterVersion WHERE status='ACTIVE'").n,
    rejectedParameterVersions: one("SELECT COUNT(*) n FROM ParameterVersion WHERE status='REJECTED'").n,
  },
  historicalBacktest: {
    oldPassedBaseRows: one("SELECT COUNT(*) n FROM BacktestRun WHERE status='PASSED' AND paramsVersion='v0.1.0-base'").n,
    latest: all('SELECT id,strategyId,status,sampleCount,winrate,evUsd,failedReasons,paramsVersion FROM BacktestRun ORDER BY id DESC LIMIT 4'),
  },
  cases,
};
db.close();
const profiles = [
  ['macro-scout','Vega','Apakah PASS matriks BTC dominance/BTC price pada empat kasus benar-benar menerangkan hasil? Bedakan fungsi veto makro, sebab loss, dan bukti timestamp yang hilang.'],
  ['universe-curator','Sena','Apakah lolos blacklist/volume/top mover membuktikan ada edge? Audit bias pemilihan universe serta metadata simbol yang harus diarsipkan point-in-time.'],
  ['regime-analyst','Rhea','Mengapa label TRENDING/ADX/CHOP lolos tetapi GRASS dan AERO rugi? Jangan simpulkan chop atau stop-hunt tanpa lintasan OHLC saat entry. Sebutkan uji pembanding.'],
  ['scanner-supervisor','Bima','Audit ranking kandidat dan planNotes TREND_FOLLOWING generik pada empat kasus. Jelaskan beda filter siap, trigger nyata, skor, dan probabilitas menang terkalibrasi.'],
  ['setup-judge','Arka','Log empat entry menunjukkan GO deterministik byLlm=false, keyakinan 0; dua loss, dua profit. Terangkan persis apa yang dapat dibenarkan dari keputusan lama, apa yang tidak, dan syarat GO riset ke depan.'],
  ['risk-officer','Wardha','Audit risiko nominal $1 vs realized GRASS -1,612R, 25x, fee, gap stop, dan 20 posisi alt berkorelasi. Pisahkan sizing yang benar secara aritmetika dari profitabilitas yang belum terbukti.'],
  ['trade-supervisor','Nadira','Bandingkan fill GRASS SL, ARX TP1+TP2, AERO SL, PUMP TP1+BE. Jelaskan kenapa beberapa profit dan loss secara akuntansi, serta risiko simulasi fill.'],
  ['watchdog','Raksa','Audit keandalan observasi: LLM byLlm=false saat entry, feed makro dan OHLC point-in-time, durabilitas ARM OFF, serta log yang perlu ditautkan ke positionId.'],
  ['post-mortem','Sesha','Bedah empat kasus tanpa mengarang sebab kausal. Evaluasi apakah jurnal loss/profit yang tersimpan berguna, apa arti orphan/duplikasi, dan hipotesis yang perlu diuji.'],
  ['strategy-tuner','Laras','Ada ratusan proposal REJECTED dan nol ACTIVE. Jelaskan kenapa belajar dari loss belum berarti parameter berubah; susun eksperimen baseline-vs-kandidat tanpa data leakage.'],
  ['backtest-auditor','Varuna','Jelaskan mengapa 90 row PASSED lama tidak boleh menjadi sertifikasi saat latest 0 sampel; kriteria OOS 500 trade, net EV, biaya, portfolio dan apa yang belum tersedia.'],
  ['narrator','Kirana','Rangkum konsensus dan perbedaan pendapat semua agen secara jujur: sebab terukur, hipotesis, keputusan sistem sekarang, serta data tambahan sebelum PAPER diaktifkan lagi.'],
];
const tiers = [profiles.slice(0,4),profiles.slice(4,6),profiles.slice(6,8),profiles.slice(8,11),profiles.slice(11)];
const answers = [];
// Keep the LLM input small: the complete immutable evidence is saved in the
// JSON artifact, while the model sees only facts needed for its role.
const evidence = `PAPER ${snapshot.paper.closed} closed, WR ${snapshot.paper.winratePct.toFixed(1)}%, net $${snapshot.paper.netUsd.toFixed(2)}, PF ${snapshot.paper.profitFactor.toFixed(2)}; S06 ${snapshot.s06.closed}/$${snapshot.s06.netUsd.toFixed(2)}, S04 ${snapshot.s04.closed}/$${snapshot.s04.netUsd.toFixed(2)}. Cases: GRASS #1033 LONG SL -1.612R; ARX #1043 SHORT TP2 +1.498R; AERO #1045 SHORT SL -1.079R; PUMP #1039 LONG TP1+BE +0.785R. All PAPER simulated; entry Arka GO byLlm=false. Parameter ACTIVE=0, latest historical backtest sample=0. ARM OFF.`;
const ask = async ([agentId,name,question]) => {
  const prior = answers.filter(x => x.answer && !x.fallback).slice(-2).map(x => `${x.name}: ${x.answer.slice(0,200)}`);
  const body = {agentId,question:`Audit retrospektif, tanpa order. ${question} Bedakan fakta dan hipotesis.`,context:{evidence,prior}};
  try {
    const r = await fetch('http://localhost:8787/api/agents/ask',{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(70000),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
    const answer = String(data.answer ?? '').trim();
    const fallback = data.byLlm !== true;
    return {agentId,name,question,answer,fallback,error:data.failureReason ?? null};
  } catch(err) {return {agentId,name,question,answer:'',fallback:false,error:String(err?.message ?? err)};}
};
for (const tier of tiers) {
  for (const profile of tier) {
    const x=await ask(profile);
    answers.push(x);
    process.stdout.write(`${x.name}: ${x.error ? `ERROR ${x.error}` : x.fallback ? 'FALLBACK' : 'OK'}\n`);
  }
}
const out = resolve('data/audit/agent-roundtable-2026-09-28.json');
mkdirSync(dirname(out),{recursive:true});
writeFileSync(out,JSON.stringify({snapshot,answers},null,2),'utf8');
process.stdout.write(`Saved ${out}\n`);
