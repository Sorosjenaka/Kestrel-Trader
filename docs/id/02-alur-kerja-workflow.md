# Alur Kerja dan Struktur Workflow

Dokumen ini memuat struktur sistem dan alur kerja lengkap Kestrel Trader,
dari pengamatan pasar sampai siklus pembelajaran. Setiap bagian dilengkapi
diagram (Mermaid — render otomatis sebagai gambar di GitHub).

Gambar statis versi PNG juga tersedia:

- Pipeline: [kestrel-pipeline-id.png](../diagrams/kestrel-pipeline-id.png)
- Workflow: [kestrel-workflow-id.png](../diagrams/kestrel-workflow-id.png)

---

## 1. Struktur sistem

Komponen utama dan bagaimana mereka saling terhubung:

```mermaid
flowchart LR
    subgraph SUMBER["Sumber Data"]
        EX[(Binance Futures<br/>REST + WebSocket)]
    end

    subgraph INTI["Mesin Inti"]
        SC[Scanner Pasar]
        AN[Analisis<br/>Multi-Timeframe]
        SG[Mesin Sinyal]
        GR[Gerbang Risiko<br/>Deterministik]
        AI[Penilai AI<br/>setup · risiko · panel tinjau]
        EK[Eksekusi Order]
        MP[Manajemen Posisi<br/>supervisor + watchdog]
    end

    subgraph SIMPAN["Penyimpanan & Antarmuka"]
        DB[(Database<br/>posisi · order · log keputusan)]
        WS[Dashboard Web<br/>realtime]
        LR[Siklus Belajar<br/>evaluasi · backtest · riset]
    end

    EX --> SC --> AN --> SG --> GR --> AI --> EK --> MP
    EK <--> EX
    MP <--> EX
    SC & AN & SG & GR & AI & EK & MP <--> DB
    DB --> WS
    DB --> LR
    LR -. pembaruan katalog .-> SG
```

---

## 2. Pipeline perdagangan (dari sinyal ke posisi)

Setiap kandidat melewati rangkaian gerbang berurutan. Semua penolakan
tercatat beserta alasannya.

```mermaid
flowchart TD
    A[Pembaruan data pasar] --> B[Analisis multi-timeframe]
    B --> C{Setup valid?}
    C -->|Tidak| X1[Lewati — tercatat]
    C -->|Ya| D[Bentuk rencana perdagangan<br/>masuk · invalidasi · keluar]
    D --> E{Gerbang likuiditas<br/>& jarak harga}
    E -->|Gagal| X2[Tolak — tercatat]
    E -->|Lolos| F{Validasi risiko<br/>ukuran · margin · proteksi}
    F -->|Gagal| X3[Tolak — tercatat]
    F -->|Lolos| G{Penilai AI<br/>setup + risiko}
    G -->|Tolak / timeout| X4[Tolak — tercatat]
    G -->|Lolos| H{Panel tinjau<br/>pra-eksekusi (voting)}
    H -->|Tidak setuju / timeout| X5[Tolak — tercatat]
    H -->|Setuju| I[Kirim order<br/>simulasi atau nyata]
    I --> J{Order terisi?}
    J -->|Tidak / kedaluwarsa| X6[Batalkan — tercatat]
    J -->|Ya| K[Posisi terbuka<br/>masuk manajemen posisi]
```

Catatan penting: semua penilai AI bersifat **fail-closed** — jika penilai
tidak tersedia, terlambat, atau gagal, kandidat **ditolak**, tidak pernah
dibiarkan lolos diam-diam.

---

## 3. Alur keputusan penilaian (detail)

```mermaid
flowchart TD
    A[Kandidat dari mesin sinyal] --> B{Penilai setup<br/>berbantuan AI}
    B -->|Setup kurang berkualitas| TOLAK([Tolak])
    B -->|Lolos| C{Petugas risiko<br/>berbantuan AI}
    C -->|Rencana risiko tidak memenuhi| TOLAK
    C -->|Lolos| D{Panel tinjau pra-eksekusi<br/>tiga peran memberi suara}
    D -->|Suara tidak bulat| TOLAK
    D -->|Disetujui| E([Lanjut ke eksekusi])

    style TOLAK fill:#fdd,stroke:#c33
    style E fill:#dfd,stroke:#3a3
```

---

## 4. Manajemen posisi (setelah order terisi)

```mermaid
flowchart TD
    A[Posisi terbuka] --> B[Pasang pelindung<br/>stop-loss + target bertingkat]
    B --> C[Pemantauan terus-menerus<br/>supervisor + watchdog]
    C --> D{Pemicu tercapai?}
    D -->|Target pertama| E[Ambil sebagian posisi<br/>geser stop ke titik impas]
    E --> C
    D -->|Target lanjutan| F[Tutup sisa posisi]
    D -->|Level invalidasi| G[Stop-loss tersentuh<br/>tutup posisi]
    D -->|Kondisi darurat| H[Proteksi darurat<br/>likuidasi · gap · volatilitas]
    F --> I[Tercatat sebagai perdagangan selesai]
    G --> I
    H --> I
    I --> J[Masuk siklus belajar]
```

---

## 5. Siklus belajar berkelanjutan

```mermaid
flowchart LR
    A[Perdagangan selesai] --> B[Evaluasi hasil<br/>kinerja · kesalahan · pola]
    B --> C[Analisis berkala<br/>laporan & wawasan]
    C --> D[Fasilitas backtest<br/>uji ide tanpa risiko]
    D --> E[Pembaruan katalog riset]
    E -.->|perbaikan berkelanjutan| F[Mesin Sinyal]
    B & C & D --> G[Dashboard<br/>riwayat & pembelajaran]
```

---

## Ringkasan alur

Data pasar → analisis multi-timeframe → sinyal tervalidasi → gerbang risiko
deterministik → penilai AI (fail-closed) → eksekusi (simulasi/nyata) →
manajemen posisi otomatis → pembelajaran → perbaikan mesin sinyal.

Untuk cara memasang sistemnya, lanjut ke [03-tutorial-pasang.md](03-tutorial-pasang.md).
