# Skema Data: ArtaTrade AI

## Perubahan kontrak perbaikan 16 Oktober 2026

- `POST /api/positions/tick` dan `POST /api/positions/:id/hit-tp1` tidak lagi menerima simulasi harga/fill dari browser (HTTP 410). Tick/fill berasal dari engine atau mock pengujian.
- `POST /api/settings/kill`, `POST /api/positions/kill-all`, dan kill per posisi mengembalikan keberhasilan hanya setelah status penutupan terkonfirmasi. Respons dapat memuat `remainingPositions`/`failures` dan HTTP 409 bila belum tuntas. Semua endpoint mutasi akun LIVE ditolak; blokir ARM LIVE tetap berlaku.
- `POST /api/positions/open` menghormati mode SCALP/SWING yang valid; input mode lain ditolak. Mode dan kebijakan backend harus sama dengan label UI.
- Validasi ilmiah dijalankan pada worker; hasil tidak didukung, dataset invalid, atau nol sampel dinyatakan eksplisit dan tidak dianggap lulus.
- Timestamp SQLite memakai integer UTC milidetik untuk field DateTime. Migrasi baru menormalisasi nilai text lama saat operator menerapkan migrasi, tanpa menulis ulang migrasi yang telah diterapkan. EventLog memiliki index createdAt untuk retensi.
- Sumber learning fallback harus berlabel DETERMINISTIC_FALLBACK. Memori/analitik tidak menyatakan perubahan bobot model atau bukti profit.

## 1. Database (SQLite via Prisma; presisi & validasi mengikuti Bagian 5)

### 1.1 Symbol - universe, klasifikasi, kelayakan

| field | tipe | wajib? | keterangan |
|---|---|---|---|
| id | INTEGER PK | ya | auto increment |
| symbol | TEXT unik | ya | contoh UNIUSDT |
| baseAsset / quoteAsset | TEXT | ya | UNI / USDT |
| contractType | TEXT | ya | tradable hanya PERPETUAL; TRADIFI_PERPETUAL = blacklist |
| underlyingType | TEXT | ya | COIN = crypto; EQUITY/COMMODITY/INDEX/FX/PREMARKET/dll = blacklist |
| status | TEXT | ya | hanya TRADING yang masuk universe |
| isBlacklisted | BOOLEAN | ya | deny-by-default dari klasifikasi + daftar manual operator |
| blacklistReason | TEXT | tidak | contoh non-crypto:EQUITY / manual / BTCDOM-data-only |
| volume24hUsd | REAL | ya | diperbarui setiap siklus ticker |
| minNotional / tickSize / stepSize | REAL | ya | dari exchangeInfo filters |
| maxLeverage | INTEGER | tidak | dari snapshot leverage; null bila belum tersedia |
| maxLeverageUpdatedAt | DATETIME | tidak | order diblokir bila snapshot lebih tua dari 7 hari |
| eligible | BOOLEAN | ya | hasil evaluasi kelayakan terakhir |
| eligibleReason | TEXT | tidak | contoh VOLUME_BELOW_MIN / CHOP_HIGH / ADX_LOW / NO_LEVERAGE_SNAPSHOT |

### 1.2 LeverageHistory - riwayat perubahan max leverage

| field | tipe | wajib? | keterangan |
|---|---|---|---|
| id | INTEGER PK | ya | |
| symbol | TEXT FK | ya | |
| maxLeverage | INTEGER | ya | nilai baru hasil deteksi |
| previousMaxLeverage | INTEGER | tidak | nilai sebelumnya |
| observedAt | DATETIME | ya | waktu deteksi |
| source | TEXT | ya | signed-endpoint / seed-manual |

### 1.3 SetupCandidate - kandidat sinyal + skor

| field | tipe | wajib? | keterangan |
|---|---|---|---|
| id | INTEGER PK | ya | |
| symbol | TEXT FK | ya | |
| createdAt | DATETIME | ya | UTC |
| mode | TEXT | ya | SCALP / SWING |
| score | INTEGER | ya | 0-100 skor gabungan (FR-13) |
| regime | TEXT | ya | TRENDING / RANGING / VOLATILE / UNCERTAIN |
| zoneScore / triggerScore / trendScore | INTEGER | ya | 0-100 tiap engine |
| knnProb | REAL | tidak | 0-1; wajib n >= 50, else null |
| knnN | INTEGER | tidak | jumlah analog pembentuk probabilitas |
| gatesPass | JSON | ya | {volume, chopAdx, macro, btcDom, leverage, minNotional} boolean |
| status | TEXT | ya | WAIT / REJECTED / JUDGED / PLANNED / EXECUTED / EXPIRED |
| rejectReason | TEXT | tidak | alasan penolakan terukur |
| agentVerdict | JSON | tidak | {setupJudge:{go,confidence,reason}, riskOfficer:{flags}} |

### 1.4 Position - posisi terbuka & tertutup

| field | tipe | wajib? | keterangan |
|---|---|---|---|
| id | INTEGER PK | ya | |
| symbol / mode / side | TEXT | ya | side LONG / SHORT |
| entryPrice / qty / notional / leverage / marginUsd | REAL | ya | margin = notional / leverage |
| slPrice / tp1Price / tp2Price | REAL | ya | TP1 = +/-1R; TP2 = +2R (scalp) / +3R (swing) |
| beMoved | BOOLEAN | ya | true setelah TP1 memindahkan SL ke entry |
| tp1FilledAt / tp2FilledAt | DATETIME | tidak | |
| status | TEXT | ya | OPEN / CLOSED |
| openedAt / closedAt | DATETIME | ya/tidak | |
| closeReason | TEXT | tidak | TP2 / SL / BE / TIMEOUT / FUNDING / KILL |
| pnlUsd / pnlR | REAL | tidak | R = $1,00 |
| outlookText | TEXT | ya | paragraf outlook Bahasa Indonesia dari agen (FR-31) |
| entryAttrs | TEXT | tidak | T-01: JSON snapshot atribut trigger + kondisi market saat entry (internal, tidak diekspos ke API) |

### 1.5 OrderExec - jejak order idempoten

| field | tipe | wajib? | keterangan |
|---|---|---|---|
| id | INTEGER PK | ya | |
| positionId | INTEGER FK | ya | |
| clientOrderId | TEXT unik | ya | ^[.A-Z:/a-z0-9_-]{1,36}$ |
| binanceOrderId | TEXT | tidak | diisi setelah acknowledgment |
| type / side | TEXT | ya | LIMIT / STOP_MARKET / TAKE_PROFIT_MARKET / MARKET(darurat) |
| price / qty | REAL | ya | presisi Bagian 5 |
| reduceOnly | BOOLEAN | ya | true untuk TP/SL |
| status | TEXT | ya | NEW / PARTIAL / FILLED / CANCELED / REJECTED |
| fillPrice | REAL | tidak | |
| feeUsd | REAL | tidak | maker 0,02% / taker 0,05% |
| createdAt / filledAt | DATETIME | ya/tidak | |

### 1.6 Trade - jurnal hasil per posisi

| field | tipe | wajib? | keterangan |
|---|---|---|---|
| id | INTEGER PK | ya | |
| positionId | INTEGER FK unik | ya | 1 trade per posisi |
| symbol / mode / side | TEXT | ya | |
| riskUsd | REAL | ya | selalu 1.00 (atau kurang bila margin cap mengikat) |
| entryAvg / exitAvg | REAL | ya | |
| rMultiple | REAL | ya | (exit-entry)/risk jarak |
| pnlUsd / feeUsd / fundingUsd | REAL | ya | PnL bersih memperhitungkan ketiganya |
| win | BOOLEAN | ya | true bila TP1 kena sebelum SL (definisi PG-01) |
| mfeR / maeR | REAL | ya | maximum favourable / adverse excursion |
| holdMinutes | INTEGER | ya | |
| entryAttrs | TEXT | tidak | T-01: salinan snapshot atribut entry dari posisi (internal) |

### 1.7 LearningEntry - hasil post-mortem

| field | tipe | wajib? | keterangan |
|---|---|---|---|
| id | INTEGER PK | ya | |
| tradeId | INTEGER FK | ya | |
| causeCode | TEXT | ya | CHOP_ENTRY / SL_TIGHT / MACRO_FLIP / LATE_ENTRY / FEE_DRAG / NEWS_SPIKE / OTHER |
| narrative | TEXT | ya | analisis Bahasa Indonesia (LLM, bukan template) |
| proposal | JSON | tidak | usulan parameter bounded untuk Tuner |
| createdAt | DATETIME | ya | |

### 1.8 ParameterVersion - versi parameter + gate

| field | tipe | wajib? | keterangan |
|---|---|---|---|
| id | INTEGER PK | ya | |
| version | TEXT unik | ya | contoh v0.1.0-base |
| params | JSON | ya | threshold & bobot engine |
| status | TEXT | ya | CANDIDATE / TESTING / ACTIVE / REJECTED / ROLLED_BACK |
| backtestRunId | INTEGER FK | tidak | wajib sebelum ACTIVE |
| activatedAt / rollbackAt | DATETIME | tidak | |

### 1.9 AgentMessage - dialog & laporan agen

| field | tipe | wajib? | keterangan |
|---|---|---|---|
| id | INTEGER PK | ya | |
| agentId | TEXT | ya | macro-scout, setup-judge, dll (AGENT.md memuat 12 id) |
| model | TEXT | ya | MiMo V2.6 Flash / DeepSeek V4.1 Flash |
| kind | TEXT | ya | BRIEF / VERDICT / SUMMARY / NARRATION / ALERT |
| textId | TEXT | ya | kalimat Bahasa Indonesia hasil LLM (non-template) |
| contextRef | JSON | ya | rujukan trade/candidate/event |
| createdAt | DATETIME | ya | |

### 1.10 Tabel pendukung (ringkas)

| Tabel | Field kunci | Fungsi |
|---|---|---|
| EventLog | id, type, severity, payload, createdAt | 100% event kritikal (NFR-12): HOST_SWITCH, WS_FAILOVER, GUARD_HIT, LEVERAGE_CHANGE, ARM, KILL, ORDER, ERROR |
| Setting | key PK, value JSON, updatedAt | arm, mode toggle, blacklistManual, threshold overrides |
| BacktestRun | id, mode, from, to, sampleCount, winrate, evUsd, maxDdUsd, feeModel, paramsVersion, status | gate FR-14/FR-28 |
| BacktestTrade | id, runId, symbol, entryAt, exitAt, rMultiple, exitReason, feesUsd | detail sampel |
| CandleCache | symbol+interval+openTime PK, o,h,l,c,v | cache klines |
| ApiHealthStat | host, windowStart, fails, p95Ms, lastError, updatedAt | dasar failover FR-23 |

Tabel wajib Fase 0: Setting, EventLog, Symbol. Sisanya dibuat bertahap sesuai fase di ROADMAP.md.
## 2. Kontrak API

Bagian ini SATU-SATUNYA sumber bentuk data FE<->BE. Frontend dilarang memanggil API eksternal langsung; semua secret lewat backend. Setiap endpoint menyebut FR-ID.

### 2.1 Internal (dashboard -> server; base http://localhost:8787)

| Method + Path | Request | Response (ringkas) | FR-ID |
|---|---|---|---|
| GET /api/health | - | {status:"ok", mode, clock:{utc, driftMs}} | FR-35 |
| GET /api/overview | - | {equityUsd, pnlDayUsd, openPositions, arm, hostActive, guard:{state, dailyUsedUsd, ddUsd}, llmCostTodayUsd, topGainers[5], topLosers[5]} | FR-29 |
| GET /api/markets/top?limit=20&all=false | query limit, all | {gainers:TopMover[20], losers:TopMover[20], refreshedAt} | FR-30 |
| GET /api/markets/scan | - | {candidates:[{symbol, score, mode, regime, gatesPass, status}], scan:{cycleMs, pairs, concurrency, refreshedAt}} | FR-07, FR-13 |
| GET /api/universe | - | {symbols:[{symbol, underlyingType, isBlacklisted, blacklistReason, volume24hUsd, minNotional, eligible, eligibleReason, maxLeverage, maxLeverageUpdatedAt}], auditCounts} | FR-01, FR-02, FR-33 |
| GET /api/leverage/history?symbol= | query symbol | {rows:[{maxLeverage, previousMaxLeverage, observedAt, source}]} | FR-33 |
| GET /api/positions | - | {positions:PositionView[]} | FR-31 |
| GET /api/positions/:id/chart?interval=1m&limit=500 | path id, query | {candles:[[t,o,h,l,c,v]], markers:[{time,type}], levels:{entry,sl,tp1,tp2}} | FR-31 |
| GET /api/trades?mode=&result=&page= | query | {trades:TradeView[], total} | FR-34 |
| GET /api/trades/:id | path id | TradeView + postMortem + orders[] | FR-27, FR-34 |
| POST /api/backtest/run | {mode, from, to, paramsVersion?} | {runId} | FR-14 |
| GET /api/parameters | - | {versions:ParameterVersion[], active:ParameterVersion|null} | FR-28 |
| POST /api/parameters/audit | {version, strategyId?, dataset:HistoricalDataset} | {audit:{status:CANDIDATE\|ACTIVE\|REJECTED, passed, sampleCount, winrate, evUsd, reason}} | FR-28 |
| GET /api/backtest/runs | - | {runs:[BacktestRun]} | FR-34 |
| GET /api/backtest/runs/:id | path id | {metrics:{winrate, evUsd, evR, maxDdUsd, samples}, distributionR[], failedGateReasons[]} | FR-14 |
| GET /api/learning | - | {entries:[LearningEntry]} | FR-27 |
| GET /api/agents | - | {agents:[{id, name, tier, model, status}], costUsd:{day, month, cap}} | FR-26 |
| GET /api/agents/feed?since= | query since | {messages:AgentMessage[]} | FR-32 |
| POST /api/agents/ask | {agentId, question} | {answer, model} | FR-32 |
| GET /api/settings | - | {arm, modes, keys:{binance:"SET|MISSING", xkiro:"SET|MISSING"}, blacklistManual[], thresholds} | FR-35 |
| PUT /api/settings | subset settings | {updated:true} | FR-35 |
| POST /api/control/arm | - | {arm:true} | FR-21, FR-35 |
| POST /api/control/disarm | - | {arm:false} | FR-21, FR-35 |
| POST /api/control/kill | {confirm:"KILL"} | {killed:true, closedPositions:n} | FR-21, FR-35 |
| POST /api/orders/plan | {candidateId} | {plan:{symbol, side, notional, qty, sl, tp1, tp2, marginUsd, leverage}, sent:false|true} | FR-15, FR-22 |
| WS /api/stream | - | events: position_update / agent_message / scan_progress / host_switch / guard_hit / leverage_change / mark_freshness | FR-25, FR-31, FR-32, FR-39 |
| POST /webhooks/tradingview (P2) | header X-TV-Token; {ticker, price, message, time} | {received:true} | FR-36 |

Parameter audit hanya berjalan di PAPER. Baseline dan kandidat memakai dataset historis identik; minimal 500 trade OOS tertutup, kandidat harus WR >=60%, EV bersih positif dan lebih baik dari baseline, serta drawdown tidak melewati baseline +5%/batas $8. Kandidat TP1_R harus benar-benar dipakai saat replay dan merupakan satu-satunya parameter runtime yang didukung. Dataset hash hanya boleh dipakai sekali untuk seleksi parameter. Field `source` dan batas OOS di `HistoricalDataset` adalah metadata yang dideklarasikan pemilik file; sistem memeriksa struktur/coverage tetapi belum membuktikan keaslian sumber secara kriptografis. Hasil audit bukan bukti profit atau izin LIVE.

TopMover = {symbol, price, chg24hPct, volume24hUsd, regime, eligible, eligibleReason}
PositionView = {id, symbol, mode, side, entry, sl, tp1, tp2, beMoved, qty, notional, marginUsd, leverage, pnlUsd, pnlR, openedAt, outlookText}
TradeView = {id, positionId, symbol, mode, side, riskUsd, entryAvg, exitAvg, rMultiple, pnlUsd, feeUsd, fundingUsd, win, mfeR, maeR, holdMinutes, closeReason, openedAt, closedAt}

Kontrak vonis setup (3 Okt 2026 — integrasi Drex, field BARU bersifat OPSIONAL dan aditif;
bentuk lama tetap valid tanpa perubahan FE):
JudgeReason = {verdict:"GO|NO-GO", confidence:0-99, confidenceKind:"SUBJECTIVE_NOT_CALIBRATED",
  winProbability:null, reason:string, byLlm:boolean, slChoice?, tpChoice?, menuFallback?,
  decisionSource?:"drex|xkiro|deterministic", entryProbability?:0..1|null,
  direction?:{choice:"LONG|SHORT", confidence?:number|null, probabilities?:object|null}|null,
  setupStrength?:{score:number, confidence?:number|null, legend?:string[]|null, probabilities?:object|null}|null,
  drexRequestId?:string|null, drexLatency?:{requestMs,responseMs,totalMs}|null,
  drexRaw?:object, drexNote?:string|null}
Catatan: confidence jalur Drex = round(entryProbability*100); winProbability SELALU null
(probabilitas GO Drex BUKAN probabilitas menang). Drex tidak pernah mengirim harga/ukuran;
menu SL/TP jalur Drex memakai default deterministik (SL A / TP A).

### 2.2 Eksternal (server -> Binance; melalui REST pool FR-23 / WS FR-24)

| Method + Path | Auth | Keterangan | FR-ID |
|---|---|---|---|
| GET /fapi/v1/exchangeInfo | publik | universe + filters (minNotional, tickSize, stepSize) | FR-01 |
| GET /fapi/v1/ticker/24hr | publik | volume & %24 jam (Top gainer/loser) | FR-03, FR-30 |
| GET /fapi/v1/klines | publik | klines multi-TF (weight 1-10 tergantung limit) | FR-07..FR-11 |
| GET /fapi/v1/leverageBracket | signed USER_DATA | maxLev + bracket margin per pair (watcher) | FR-16 |
| POST /fapi/v1/order (LIMIT/STOP_MARKET/TAKE_PROFIT_MARKET) | signed TRADE | eksekusi + TP/SL reduceOnly | FR-22 |
| GET /fapi/v1/positionRisk | signed | reconcile posisi | FR-22, NFR-04 |
| WS !markPrice@arr@1s (fstream/fstream1) | publik | mark price SEMUA simbol tiap 1 dtk; freshness p95 <= 1.000 ms; auto-resubscribe bila gap > 2 dtk. CATATAN T-1.2: Binance sedang migrasi URL WS futures ke struktur path /public /market /private - implementasi HARUS mendukung format lama dan baru | FR-39 |
| WS kline/aggTrade/bookTicker watchlist + userDataStream | signed utk user stream | data laga trigger + fill event | FR-24 |

### 2.3 State Frontend (bentuk data di UI)

- OverviewState {equityUsd, pnlDayUsd, openPositions, arm, hostActive, guardState, llmCostTodayUsd, topGainers[5], topLosers[5]}
- MarketsState {gainers[20], losers[20], filter{minVolumeUsd, showAll}, refreshedAt, scan{cycleMs, pairs}}
- PositionsState {positions[], selectedId, chart{candles, markers, levels}, outlookText, timeline[]}
- AgentsState {agents[], feed[], costUsd, degraded, workspaceAnim:{positions[], mood}}
- LearningState {entries[], parameterVersions[], activeVersion}
- SettingsState {arm, modes, keysMasked{binance, xkiro}, blacklistManual[], thresholds}

## 4. Contoh Data Nyata (1 JSON utuh per entity)

Contoh TopMover (response /api/markets/top):
{"gainers":[{"symbol":"UNIUSDT","price":12.34,"chg24hPct":8.42,"volume24hUsd":1292200000,"regime":"TRENDING","eligible":true,"eligibleReason":null}],"refreshedAt":"2026-09-24T13:04:12Z"}

Contoh SetupCandidate (baris DB):
{"id":4211,"symbol":"NEARUSDT","mode":"SCALP","score":78,"regime":"VOLATILE","zoneScore":82,"triggerScore":74,"trendScore":77,"knnProb":0.71,"knnN":64,"gatesPass":{"volume":true,"chopAdx":true,"macro":true,"btcDom":true,"leverage":true,"minNotional":true},"status":"JUDGED","agentVerdict":{"setupJudge":{"go":true,"confidence":0.74,"reason":"Zona OB+FVG searah trend, chip rendah"}}}

Contoh PositionView:
{"id":508,"symbol":"UNIUSDT","mode":"SCALP","side":"LONG","entry":12.4,"sl":12.31,"tp1":12.49,"tp2":12.58,"beMoved":false,"qty":10.7,"notional":132.68,"marginUsd":5.31,"leverage":25,"pnlUsd":0.12,"pnlR":0.09,"openedAt":"2026-09-24T13:01:33Z","outlookText":"Harga memantul dari zona demand dengan volume naik; target pertama 1R di 12,49 lalu BE."}

Contoh TradeView (tertutup):
{"id":301,"positionId":298,"symbol":"SOLUSDT","mode":"SWING","side":"SHORT","riskUsd":1.0,"entryAvg":136.2,"exitAvg":135.55,"rMultiple":0.62,"pnlUsd":0.58,"feeUsd":0.06,"fundingUsd":0.01,"win":true,"mfeR":1.1,"maeR":-0.35,"holdMinutes":214,"closeReason":"TP2","openedAt":"2026-09-23T22:10:00Z","closedAt":"2026-09-24T01:44:00Z"}

## 5. Validasi (range, format, presisi - EKSPLISIT)

- Uang USDT: 2 desimal; R eksak 1.00; fee dibulatkan ke atas 2 desimal; PnL 2 desimal.
- Persen: 2 desimal; SL effektif 0,50%-2,50%; di luar rentang ditolak.
- Harga order: dibulatkan ke tickSize terdekat; qty: dibulatkan ke BAWAH ke kelipatan stepSize (menghindari over-risk).
- notional >= minNotional (umumnya 5 USDT; BTCUSDT 50 USDT); margin <= 40% equity; total posisi OPEN <= 2; 1 posisi per simbol.
- Leverage: integer 1-125 dan <= maxLeverage snapshot (maks umur snapshot 7 hari).
- riskUsd <= 1.00 selalu; bila margin cap mengikat, risk diturunkan proporsional (contoh notional cap $200 pada SL 0,4% menghasilkan risk $0,80).
- clientOrderId: regex ^[\.A-Z\:/a-z0-9_-]{1,36}$; unik selamanya (idempoten).
- Waktu: UTC ISO-8601 dengan detik; semua perbandingan memakai UTC.
- score integer 0-100; knnProb 0-1 hanya bila n >= 50; regime enum 4 nilai.
# Research swing PAPER status (18 Oktober 2026)

`GET /api/research/swing-paper/status` membaca worker terisolasi pada loopback8791. Tidak memulai worker atau order. Worker hanya public-market-data + wallet simulasi JSON tersendiri; tidak memakai tabel posisi LIVE.

200: `{schemaVersion:1, mode:"ISOLATED_PAPER_ONLY", running:boolean, createdAt:number, lastCycleAt:number|null, initialBalanceUsd:40, cashUsd:number, equityUsd:number, evaluatedSymbols:number, universeSymbols:38, maxPositions:3, maxDailyLosses:6, leverage:25, marginMode:"CROSS", liveEnabled:false, resetAvailable:false, metrics:{trades:number,winratePct:number|null,profitFactor:number|null,netPnl:number,longTrades:number,shortTrades:number}, strategies:Record<RSW-01|RSW-02|RSW-03,metrics>, pending:PaperPosition[],positions:PaperPosition[],closed:PaperTrade[],decisions:PaperDecision[],errors:Array<{symbol?:string,reason:string}>|null,model:object|null,limitations:string[]}`.

PaperPosition: `{id,strategyId,symbol,side,entry,sl,initialSl,qty,originalQty,riskUsd,submittedAt,expiry,phase,fees,funding,gross,legs,...signalProvenance}`. PaperTrade menambahkan `exitTime` dan `netPnl`. Leg: `{kind,qty,price,time,fee,gross}`. Decision: `{time,strategyId,symbol,side,reason}`. Angka waktu epochms UTC; daily-loss dihitung WIB. Equity berdasarkan close15m terakhir, bukan mark intratick. PF null saat loss denominator nol, bukan infinity buatan. Closed response dibatasi100 terakhir; ledger seluruhnya tetap tersimpan. Seed model forwardTransfer=true wajib dibedakan dari hasil backtest RR baru.

503 bridge: `{mode:"ISOLATED_PAPER_ONLY",running:false,liveEnabled:false,error:string}` ketika worker belum tersedia. Tidak ada reset/topup/start/LIVE mutation endpoint pada worker ini.

