// tools/agent-eval-params.mjs — Evaluasi RETROSPEKTIF 12 agent tentang history
// trade PAPER + rencana parameter baru (perintah operator 30 Sep 2026).
// Read-only terhadap trading: HANYA memakai /api/agents/ask (tak membuka/menutup
// posisi, tak mengubah setting). Jawaban disimpan ke data/audit/.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 25 Okt 2026 (FASE 1 auth): mutasi /api/agents/ask wajib x-api-token
// (loopback tidak lagi bypass). Token dibaca dari .env, tidak dicetak/log.
const ENV_PATH = resolve(process.env.ARTA_ROOT ?? '/opt/kestrel', '.env');
const API_TOKEN = (readFileSync(ENV_PATH, 'utf8').match(/^API_MUTATION_TOKEN=(.*)$/m)?.[1] ?? '').trim();
if (!API_TOKEN) {
  console.error(`GAGAL: API_MUTATION_TOKEN tidak ada di ${ENV_PATH}`);
  process.exit(1);
}

const STATS = `History sesi PAPER 2026-09-29 07:00 -> 2026-09-30 07:00 WIB (20 trade tertutup, 5 win = 25% WR, net -$20.88, avg -1.58R, modal start $200 -> equity $179.12, 1 posisi OPEN ZECUSDT SHORT).
Per strategi: S-03 Liquidity Sweep Reclaim: 9 trade, 0 win, -$16.04; S-01 Squeeze Breakout: 8 trade, 3 win, -$5.90; S-05 HA Smooth Scalper: 3 trade, 2 win, +$1.06.
Masalah: loss ekstrem -4.00R (LINK), -5.79R (0G), -9.23R basis jarak (0G) padahal SL direncanakan ~1R; winner hanya +0.97R s/d +1.20R (fee makan profit); S-03 nihil kemenangan.`;

const PLAN = `Rencana parameter baru: (a) RESET saldo paper ke $200 (history diarsip); (b) risiko TETAP $0.60 loss per trade (dari $1); (c) TP single-target SCALP 2.1667R = $1.30 per trade (dari 1.6R/$1); (d) margin otomatis kecil ~$1-2 per posisi (plafon $4.8), leverage 25x CROSS; (e) ARM auto-aktif, scan 50 pair paralel (tetap); (f) tetap PAPER.`;

const QUESTIONS = {
  'risk-officer': `Sebagai perwira risiko: apakah parameter baru LAYAK diterapkan (ya/tidak + syarat)? Apa saran spesifik dari history agar -4R/-9R tidak terulang?`,
  'post-mortem': `Sebagai bedah kasus loss: bedah kenapa S-03 0/9 win dan loss bisa -4R s/d -9R (SL slip? gap? aset illiquid?). Saran konkret + apakah parameter baru LAYAK diterapkan?`,
  'setup-judge': `Sebagai hakim setup: dari 20 trade ini, setup mana yang seharusnya DITOLAK sejak awal? Apakah TP 2.1667R wajar untuk kualitas setup ini, dan apakah parameter baru LAYAK diterapkan?`,
  'strategy-tuner': `Sebagai penyetel parameter: dengan bukti S-01/S-03/S-05 di atas, apakah risiko $0.60 + TP 2.1667R + margin ~$1-2 adalah setelan yang layak, atau ada bound yang lebih baik?`,
  'trade-supervisor': `Sebagai supervisor eksekusi: evaluasi gap antara SL direncanakan (~1R) dan fill loss -4R/-9R. Apa perbaikan eksekusi yang disarankan dan apakah parameter baru LAYAK diterapkan?`,
  'macro-scout': `Sebagai pengamat makro: apakah kerugian sesi ini disebutkan konteks makro (BTC.D/market)? Apakah market condition mendukung ARM ON dengan parameter baru, ya/tidak?`,
  'regime-analyst': `Sebagai analis regime: apakah regime volatility saat ini cocok untuk SCALP 50 paralel + ARM ON + TP 2.17R? Saran + apakah layak diterapkan?`,
  'scanner-supervisor': `Se sebagai koordinator scanner: apakah 50 worker paralel + MTF efektif 3 (cap 2..3) cukup untuk kecepatan analisis, atau ada bottleneck nyata di history ini? Parameter baru layak/tidak?`,
  'backtest-auditor': `Sebagai auditor backtest: apakah sample 20 trade cukup untuk menyimpulkan strategi baru layak? Apa bukti minimal sebelum ARM ON permanen?`,
  'watchdog': `Sebagai watchdog infra: dari sisi operasional, apakah reset $200 + ARM ON + param baru aman dijalankan 24/7 di VPS ini? Ya/tidak + risiko yang harus dipantau.`,
  'narrator': `Sebagai pencerita: ringkas rencana diskusi ini dalam 3 kalimat dan sebutkan verdict tim (bila ada) tentang apakah parameter baru LAYAK diterapkan.`,
  'universe-curator': `Sebagai kurator universe: apakah simbol-simbol yang loss besar (0GUSDT, LINKUSDT, FFUSDT, GRASSUSDT) layak di-blacklist dari scan? Saran + apakah parameter baru LAYAK diterapkan?`,
};

const API = 'http://127.0.0.1:8787/api/agents/ask';
const entries = Object.entries(QUESTIONS);
const results = [];
const CONCURRENCY = 4;

async function ask([agentId, tail]) {
  const question = `Audit retrospektif TANPA order (read-only). ${STATS} ${PLAN} ${tail} Jawab maksimal 140 kata, konkret, sebutkan verdict AKTIF: "LAYAK" atau "BELUM LAYAK".`;
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-token': API_TOKEN },
      body: JSON.stringify({ agentId, question }),
      signal: AbortSignal.timeout(90000),
    });
    const json = await res.json().catch(() => ({}));
    results.push({ agentId, ok: res.ok, answer: json?.answer ?? json?.text ?? JSON.stringify(json).slice(0, 2000) });
    console.log(`[done] ${agentId}`);
  } catch (e) {
    results.push({ agentId, ok: false, answer: `ERROR: ${e.message}` });
    console.log(`[fail] ${agentId}: ${e.message}`);
  }
}

let idx = 0;
async function worker() {
  while (idx < entries.length) {
    const item = entries[idx++];
    await ask(item);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const outDir = resolve('data', 'audit');
mkdirSync(outDir, { recursive: true });
const outFile = resolve(outDir, 'agent-eval-params-2026-09-30.json');
writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), stats: STATS, plan: PLAN, results }, null, 1), 'utf8');
console.log(`SAVED ${outFile} (${results.length} agents)`);
