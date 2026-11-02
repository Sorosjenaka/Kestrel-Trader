# Ikhtisar dan Fitur

## Apa itu Kestrel Trader?

Kestrel Trader adalah sistem trading otomatis untuk pasar Binance USDT-M Futures.
Sistem memantau ratusan pair secara realtime, menghasilkan sinyal dari analisis
multi-timeframe, menilai setiap kandidat lewat beberapa lapisan peninjauan
(deterministik + berbantuan AI), lalu mengeksekusi dan mengelola posisi secara
otomatis — sampai dengan siklus pembelajaran berkelanjutan.

Keamanan sejak awal: **mode default adalah simulasi (paper)** dan saklar
eksekusi nyata (ARM) dalam keadaan **OFF**, sehingga tidak ada order sungguhan
yang terkirim sampai Anda menyalakannya sendiri secara sadar.

## Daftar fitur

### 1. Scanner pasar realtime
- Memantau seluruh pair futures yang memenuhi syarat likuiditas, via REST + WebSocket.
- Harga, volume, dan status koneksi disegarkan terus-menerus; data yang tidak
  segar tidak akan pernah dipakai untuk keputusan.

### 2. Mesin sinyal multi-timeframe
- Analisis tren, momentum, struktur harga, volatilitas, dan profil volume
  di beberapa timeframe sekaligus.
- Setiap sinyal membawa level masuk, level invalidasi, dan rencana keluar
  yang tervalidasi — bukan tebakan.

### 3. Penilai AI berlapis (fail-closed)
- **Penilai setup** — menilai kualitas setup sebelum eksekusi.
- **Petugas risiko** — memvalidasi rencana risiko posisi.
- **Panel tinjau pra-eksekusi** — beberapa peran peninjau memberikan suara;
  tanpa persetujuan, kandidat ditolak.
- Semua penilaian AI bersifat *fail-closed*: timeout atau error = ditolak,
  tidak pernah "lolos karena gagal".

### 4. Gerbang risiko deterministik
- Validasi ukuran posisi, jarak proteksi, dan batas penggunaan margin.
- Perlindungan dari likuidasi, batas kerugian harian, jeda antar-entri, dan
  penjaga volatilitas ekstrem.
- Semua keputusan tercatat dengan alasannya (audit trail).

### 5. Manajemen posisi otomatis
- Ladder take-profit bertingkat dan pemindahan stop ke titik impas secara otomatis.
- Pengawas posisi (supervisor + watchdog) yang memantau posisi terbuka terus-menerus.
- Rekonsiliasi berkala antara database dan posisi nyata di exchange.

### 6. Mode simulasi & saklar eksekusi
- Mode paper: seluruh alur berjalan penuh (sinyal → penilaian → "order" simulasi →
  manajemen posisi) tanpa menyentuh exchange.
- Saklar ARM untuk mengaktifkan eksekusi nyata — terpisah, eksplisit, dan aman.

### 7. Dashboard web realtime
- KPI trading, grafik kurva ekuitas dan posisi, riwayat trade, log keputusan,
  status setiap penilai AI, dan feed event sistem.
- Pembaruan harga & PnL realtime via WebSocket.

### 8. Siklus belajar berkelanjutan
- Evaluasi hasil trading, fasilitas backtest, dan katalog riset strategi
  untuk pengembangan berkelanjutan.

### 9. Operasional & ketahanan
- Watchdog proses, penjaga rate-limit exchange (backoff otomatis), backup
  database terjadwal, dan skrip rilis dengan rollback otomatis.

## Cara kerja secara garis besar

1. **Scan** — scanner mengambil data pasar terbaru untuk semua pair yang lolos filter.
2. **Analisis** — setiap pair dianalisis multi-timeframe menjadi satu pandangan setup.
3. **Sinyal** — mesin sinyal menghasilkan kandidat lengkap dengan rencana
   masuk/invalidasi/keluar.
4. **Penilaian** — kandidat melewati gerbang risiko deterministik, lalu
   penilai AI (setup, risiko, panel tinjau). Semua *fail-closed*.
5. **Eksekusi** — kandidat yang lolos semua gerbang menjadi order (simulasi
   atau nyata, tergantung mode).
6. **Manajemen** — posisi dikelola otomatis (ladder keluar, proteksi, pengawasan).
7. **Belajar** — hasil setiap perdagangan dievaluasi dan masuk ke siklus
   pembelajaran.

Detail lengkap beserta diagramnya ada di [02-alur-kerja-workflow.md](02-alur-kerja-workflow.md).
