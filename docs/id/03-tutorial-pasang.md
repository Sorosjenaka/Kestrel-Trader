# Tutorial Pemasangan

Panduan langkah demi langkah untuk memasang dan menjalankan Kestrel Trader
di komputer Anda sendiri. Pastikan tetap dalam **mode simulasi (PAPER)** sampai
Anda benar-benar paham cara kerjanya.

## 1. Prasyarat

- **Node.js ≥ 20** dan **npm** (`node -v` untuk memeriksa)
- **Git**
- **Akun Binance USDT-M Futures** + API key (hak baca + trade, **tanpa** hak
  withdraw). Untuk awal, cukup dipakai dengan mode simulasi.

## 2. Ambil kode

```bash
git clone https://github.com/Sorosjenaka/Kestrel-Trader.git
cd Kestrel-Trader
```

## 3. Siapkan konfigurasi

1. Salin template konfigurasi:

   ```bash
   cp .env.example apps/server/.env
   ```

2. Buka `apps/server/.env` lalu isi **API key Anda sendiri**:
   - `BINANCE_API_KEY=` dan `BINANCE_API_SECRET=`
   - Biarkan `BINANCE_EXECUTION_MODE=PAPER` (mode simulasi).
3. Salin juga untuk web (hanya satu baris yang diperlukan):

   ```bash
   cp .env.example apps/web/.env
   ```

   lalu sisakan hanya `VITE_API_BASE_URL` (arahkan ke alamat server Anda,
   default `http://localhost:8787`).

> **PENTING:** jangan pernah membagikan isi file `.env`, menempelkannya ke
> chat, atau meng-commit-nya ke Git. File ini sudah masuk daftar abaikan Git
> (`.gitignore`) secara bawaan.

## 4. Install dependensi

```bash
npm install
```

## 5. Build

```bash
npm run build
```

## 6. Jalankan

- Server (mesin trading + API):

  ```bash
  npm run dev:server
  ```

- Dashboard web (di terminal lain):

  ```bash
  npm run dev:web
  ```

- Atau keduanya sekaligus:

  ```bash
  npm run dev:local
  ```

## 7. Verifikasi instalasi

1. Cek status server:

   ```bash
   npm run health
   ```

   Harus muncul respons berisi status `ok` dan mode eksekusi `PAPER`.

2. Buka dashboard di browser (alamat web server, default `http://localhost:5173`
   untuk mode pengembangan).

3. Pastikan di dashboard terlihat:
   - data harga pasar bergerak realtime,
   - scanner berjalan (kandidat mulai muncul),
   - tidak ada order nyata yang terkirim (mode simulasi).

## 8. Beralih ke eksekusi nyata (kapan-kapan, jika sudah siap)

Hanya lakukan ini setelah Anda puas dengan hasil simulasi:

1. Ganti `BINANCE_EXECUTION_MODE=LIVE` di `apps/server/.env`.
2. Nyalakan saklar eksekusi (ARM) dari dashboard — ini pengaman terpisah
   yang secara bawaan selalu OFF, dan tidak menyala otomatis saat restart.
3. Mulai dengan ukuran posisi sekecil mungkin.

## 9. Pembaruan & pemeliharaan

```bash
git pull
npm install
npm run build
```

Lalu jalankan ulang server. Backup database tersedia lewat skrip bawaan di
`tools/` (lihat `deploy/` untuk rilis dengan rollback otomatis).

## Pemecahan masalah singkat

| Gejala | Penyebab umum |
|---|---|
| `npm run health` tidak merespons | Server belum jalan / port bentrok — cek proses dan `PORT` di `.env` |
| Dashboard tidak menampilkan data | `VITE_API_BASE_URL` tidak sesuai alamat server |
| Koneksi exchange gagal | API key salah / tidak punya izin Futures / IP belum di-whitelist |

## Peringatan risiko

Trading berisiko tinggi. Perangkat lunak ini disediakan apa adanya (MIT
license). Selalu uji dalam mode simulasi lebih dulu, dan jangan pernah
memasukkan dana yang tidak siap Anda tanggung kerugiannya.
