# Arsitektur: ArtaTrade AI

## 1. Tech Stack

| Layer | Teknologi | Alasan (rujuk NFR-ID) |
|---|---|---|
| Frontend | Vite + React + TypeScript; Lightweight Charts v5.2; TradingView Widget embed | NFR-06 (FCP <= 2 dtk), NFR-11 |
| Backend | Node.js + Express (TypeScript), semua waktu UTC | NFR-02, NFR-11 |
| Database | SQLite + Prisma | NFR-07 (single-user lokal) |
| Penjadwal | node-cron + worker-pool internal (concurrency 50) | NFR-01, FR-07 |
| Koneksi Binance | REST fetch + HMAC SHA256; WebSocket (ws) | FR-22, FR-23, FR-24 |
| LLM | Xkiro (endpoint OpenAI-compatible): MiMo V2.6 Flash + DeepSeek V4.1 Flash | FR-26, NFR-05 |
| Logging | pino + redaksi field rahasia | NFR-08, NFR-12 |
| Test | Vitest + Supertest (node), pytest disiapkan tidak dipakai dulu | Definisi Selesai Rules Bagian 5 |
| Env | dotenv, .env terpisah (server/web) + .env.example | NFR-08 |
| Deploy awal | Windows lokal: start.ps1 + Task Scheduler + watchdog | NFR-04, NFR-11 |

Catatan lisensi: Lightweight Charts mewajibkan atribusi TradingView (link + NOTICE) di halaman publik; widget TV mengikuti branding bawaannya.

## 2. Diagram Alur Sistem (ASCII)

```
BINANCE LIVE (REST pool + WS pool, fallback otomatis)
        |
        v
[UNIVERSE MANAGER]-- klasifikasi crypto-only + blacklist + audit (FR-01, FR-02)
        |            + [LEVERAGE WATCHER] snapshot/diff maxLev tiap 6 jam (FR-16, FR-33)
        v
[SCANNER POOL 50 PARALEL] (FR-07) - kadens 60 dtk scalp / 300 dtk swing
        |
        v
[ENGINE SINYAL] regime (FR-08) | zona SMC/SnD (FR-09) | trigger (FR-10) | trend (FR-11)
        |
        v
[LIBRARY ANALOG KNN + SKOR GABUNGAN 0-100] (FR-12, FR-13)
        |
        v
[GATE MAKRO] BTCUSDT + ETHUSDT (FR-05) + BTCDOMUSDT BTC.D (FR-06)
        |
        v
[AGEN LLM x12: riset -> judge -> risk -> supervisor -> evaluator] (FR-26)
        |
        v
[RISK ENGINE deterministik] sizing $1, leverage 25x cap, margin cap 40% (FR-15, FR-16)
        |
        v
[EXECUTOR] idempoten + maker-first | ARM gate (FR-22, FR-35) 
        |
        v
[SUPERVISOR] TP1 65% + SL->BE, TP2 35%, timeout, funding-aware (FR-17, FR-18, FR-19)
        |
        v
[JURNAL + LEARNING LOOP] post-mortem (FR-27) -> ParameterVersion + gate backtest (FR-28)
        |
        v
[DASHBOARD 8 HALAMAN + RUANG KERJA AGEN] (FR-29..FR-35)
```

## 3. Struktur Folder (rencana)

```
Baru/  (root proyek = workspace)
|-- apps/
|   |-- server/
|   |   |-- src/
|   |   |   |-- core/        (config, logger, time, result)
|   |   |   |-- marketdata/  (rest pool, ws manager, klines, ticker)
|   |   |   |-- universe/    (klasifikasi, blacklist, leverage watcher)
|   |   |   |-- engines/     (regime, zona, trigger, trend, knn, skor)
|   |   |   |-- agents/      (adapter llm, 12 agen, memori, narasi)
|   |   |   |-- risk/        (sizing, guard, validasi)
|   |   |   |-- exec/        (executor, supervisor, reconcile)
|   |   |   |-- learning/    (post-mortem, tuner, gate backtest)
|   |   |   |-- api/         (rute express + ws internal)
|   |   |   |-- jobs/        (cron: scan, sync, watcher, laporan)
|   |   |-- tests/
|   |-- web/
|       |-- src/
|           |-- pages/       (8 dashboard)
|           |-- components/  (chart, tabel, kartu, workspace agen)
|           |-- lib/         (api client, format)
|-- packages/shared/         (tipe kontrak Schema Bagian 2, util)
|-- prisma/                  (schema.prisma, migrasi)
|-- data/                    (SQLite, log)
|-- .env.example
|-- .gitignore
|-- README.md + 9 dokumen (file ini)
```

## 4. Alur Data Kritis

1) Siklus scan (60 dtk): REST pool menarik ticker/klines utk universe -> engine sinyal menghitung skor -> kandidat tersimpan (SetupCandidate) -> dashboard Markets tersegarkan (FR-30).
2) Siklus keputusan: kandidat skor >= 70 + gate makro lolos -> agen Setup Judge & Risk Officer menilai -> Risk Engine menghitung angka final -> bila ARM ON, order dikirim; bila OFF, rencana order dicatat tapi 0 order dikirim (FR-15, FR-22).
3) Siklus eksekusi & pengawasan: order idempoten -> verifikasi fill -> TP1 memicu 65% close + SL pindah ke entry -> TP2 menutup 35% -> timeout/funding menutup sisa; semua event ditulis jurnal (FR-17..FR-19, FR-25).
4) Siklus pembelajaran: posisi tutup -> evaluator menulis post-mortem -> statistik per setup diperbarui -> Tuner mengusulkan ParameterVersion -> Backtest Auditor menjalankan gate >= 1.000 sampel -> lulus: aktifkan; gagal: rollback (FR-27, FR-28).

## 5. Komponen Utama & Tanggung Jawab

| Komponen | Tanggung jawab | FR-ID |
|---|---|---|
| Marketdata | REST pool + circuit breaker, WS manager (markPrice@arr@1s semua pair + freshness/quarantine), cache klines | FR-23, FR-24, FR-39 |
| Universe | Klasifikasi crypto-only, blacklist, audit | FR-01, FR-02 |
| Leverage Watcher | Snapshot maxLev + diff 6 jam + riwayat | FR-16, FR-33 |
| Scanner | Worker pool 50 paralel + metrik siklus | FR-07 |
| Engines | Regime, zona, trigger, trend, KNN, skor gabungan | FR-08..FR-13 |
| Macro Gate | BTC/ETH regime + BTC.D BTCDOMUSDT | FR-05, FR-06 |
| Agents | 12 agen LLM + adapter + memori + tracker biaya | FR-26, FR-32 |
| Risk | Sizing, margin cap, guard harian, validasi bracket | FR-15, FR-20, FR-21 |
| Exec | Executor idempoten, supervisor TP/SL/timeout, reconcile | FR-17..FR-19, FR-22 |
| Learning | Post-mortem, tuner, gate backtest, versioning | FR-27, FR-28 |
| API | REST internal + WS dashboard + webhook receiver (P2) | FR-29..FR-36 |
| UI | 8 dashboard + ruang kerja agen + chart overlay | FR-29..FR-35 |

## 6. Keamanan - Implementasi

- API key Binance & Xkiro HANYA di file `.env` sisi server (gitignored); frontend tidak pernah memegang secret (NFR-08).
- Log pino meredaksi field: apiKey, apiSecret, authorization, token (NFR-08, NFR-12).
- Request signed: HMAC SHA256 + timestamp + recvWindow 5000 ms; cek drift jam saat start (FR-22, FR-23).
- CORS: hanya origin dashboard lokal (default http://localhost:4000).
- ARM gate default OFF; kill switch menghentikan entry & menutup semua (FR-21, FR-35).
- Order idempoten via clientOrderId deterministik; verifikasi posisi vs exchange setiap 60 dtk (FR-22, NFR-04).
- Target keamanan (standar OWASP Top 10, target angka & verifikasi) ada di PRD Bagian 6 NFR-08.

## 7. Titik Kegagalan & Mitigasi

| Kegagalan | Dampak | Mitigasi | NFR-ID |
|---|---|---|---|
| Host REST 418/429/5xx | Scan gagal sementara | Pool fapi1-4 + circuit breaker 30 dtk + retry 3x | FR-23, NFR-03 |
| WS putus | Data laga (stale) | Reconnect <= 10 dtk, pindah fstream1, degradasi REST | FR-24, NFR-03 |
| Mark price gap > 2 dtk (pair mana pun) | Potensi entry di harga usang | Stempel STALE + blokir entry pair; auto-resubscribe; quarantine bila macet > 5 dtk | FR-39, NFR-15 |
| PC mati / listrik | Posisi tanpa pengawasan | Reconcile saat boot <= 5 mnt + jurnal | NFR-04, NFR-14 |
| Internet putus | Semua data laga | Guard: entry diblokir saat data > 120 dtk; banner status | NFR-03 |
| maxLev pair berubah turun | Leverage tidak sesuai | Watcher diff 6 jam + alert + blokir entry sampai snapshot baru | FR-16, FR-33 |
| Limit LLM Go tercapai | Agen berhenti | Tracker 80% -> degradasi mode (agen kritikal saja) | NFR-05, FR-26 |
| Drift jam server | Signature ditolak | Time-sync check saat start + sebelum order | FR-22, NFR-02 |
| Slippage eksekusi | Risk melebihi rencana | Maker-first + slippage check terhadap SL; batalkan jika lewat toleransi | NFR-02, NFR-09 |
