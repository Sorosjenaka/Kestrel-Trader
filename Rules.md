# Aturan Proyek: ArtaTrade AI

## 1. Golden Rules (10 aturan yang tidak boleh dilanggar)

1. Angka uang 100% deterministik; LLM dilarang menghitung nominal uang.
2. Kontrak FE<->BE hanya dari Schema.md Bagian 2; mengubah kontrak = update Schema.md dahulu, baru kode.
3. ARM default OFF; tidak ada order terkirim tanpa ARM eksplisit dari operator.
4. Risiko per trade <= $1,00 (tidak pernah lebih); average down dilarang.
5. SL wajib <= 2,5% (liquidation guard 25x); SL scalp 0,5%-1,0%; swing 1,0%-2,5%.
6. Semua order idempoten (clientOrderId) dan maker-first; market order hanya untuk darurat yang wajib tercatat di jurnal.
7. API key hanya di apps/server/.env; tidak pernah tampil di UI, log, chat, maupun dokumen.
8. Hanya pair crypto (whitelist contractType=PERPETUAL + underlyingType=COIN + quoteAsset=USDT); blacklist mengalahkan semua filter lain.
9. Perubahan parameter hanya lewat ParameterVersion + gate backtest (FR-28).
10. Setiap klaim performa wajib bukti angka (output terminal/DB); "seharusnya jalan" = GAGAL.

## 2. Konvensi Coding

- TypeScript strict; penamaan file kebab-case; fungsi <= 50 baris.
- Validasi input di batas sistem dengan zod (kontrak Binance & API internal).
- Tangani error dengan pola Result (ok/err), bukan lempar-liar.
- Log terstruktur pino; field rahasia diredaksi; tanggal UTC ISO-8601.
- Uang: Number dengan pembulatan eksplisit (lihat Schema.md Bagian 5); presisi diuji di unit test.
- Komentar hanya untuk alasan bisnis, bukan deskripsi kode.

## 3. Konvensi Git

- Format commit: "type(scope): pesan"; type: feat|fix|chore|docs|test|refactor; scope: server|web|engine|risk|agents|marketdata|docs|infra.
- Branch: feat/nama-fitur; 1 tugas ROADMAP = 1 commit; dilarang commit .env atau file data/.
- Pesan commit wajib menyebut ID tugas (contoh: "feat(engine): T-1.7 regime + trend engine (FR-08, FR-11)").

## 4. Aturan Bisnis (logika domain)

- Sizing: notional = R / SL_pct; margin = notional / leverage; leverage = min(25, maxLev pair); margin <= 40% equity; notional >= minNotional simbol.
- R = $1,00; bila margin cap mengikat, risiko diturunkan proporsional (tidak pernah > $1,00).
- Exit aktif: SWING memakai RR23 — TP1 50% qty di 2R, SL sisa ke entry/BE setelah TP1 terkonfirmasi, runner 50% di TP2/final 3R. Tidak ada TPMAX terpisah. SCALP tetap single-target 1.7R; timeout 90 menit (scalp) / 12 jam (swing).
- Fee: maker 0,02%, taker 0,05%; semua EV dihitung bersih-fee; diskon BNB opsional operator.
- Guard: daily stop NONAKTIF (perintah operator 29 Sep 2026); auto-disarm drawdown NONAKTIF (perintah operator 29 Sep 2026); kill switch manual menutup semua posisi.
- Kelayakan pair: volume futures 24 jam > $7.000.000; ADX(14) >= 20; Choppiness < 58,3; snapshot maxLev <= 7 hari; gate makro lolos.
- BTC.D gate: kenaikan BTCDOMUSDT > 0,5% dalam 1 jam memblokir entry alt.

## 5. Definisi "Selesai"

- [ ] Semua FR terkait lolos acceptance criteria US-nya (PRD Bagian 4.2)
- [ ] Semua NFR terkait lolos Verifikasi (PRD Bagian 6) dengan bukti angka
- [ ] 1 happy-path test per FR P0 lulus (Vitest + Supertest)
- [ ] Zero item Out-of-Scope (PRD Bagian 7.2) ikut terimplementasi
- [ ] README.md masih akurat dengan cara run terbaru

## 6. Larangan

- Install library di luar pre-approved tanpa izin operator (daftar izin ada di AGENT.md).
- Mengubah Schema.md tanpa memperbarui kode terkait (atau sebaliknya).
- Commit .env, data/SQLite, atau output log ke git.
- Menampilkan nilai API key di UI, log, chat, atau dokumen.
- Rewrite total tanpa diagnosis tertulis (Protokol Debug: error lengkap -> fix terkecil -> uji ulang -> catat "Fix:" di CHANGELOG.md).
- Order tanpa clientOrderId; trading pair non-crypto; memakai testnet/demo Binance (keputusan operator); menyalin kode Pine berlisensi pihak ketiga.
