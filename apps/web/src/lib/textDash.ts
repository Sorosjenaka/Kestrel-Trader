// apps/web/src/lib/textDash.ts
// Normalisasi tanda baca untuk teks UI tema B.
//
// Aturan 8 brief redesign: tidak ada em dash (—), en dash (–), atau " - "
// sebagai pemisah di teks UI. Teks yang berasal dari SERVER (analisis panel,
// jurnal learning, laporan agen, pesan error mesin) tidak boleh diubah di
// server pada tahap 1-6, jadi normalisasi dilakukan di lapisan tampilan.
//
// Pengecualian yang tetap dipertahankan (aturan 8): tanda minus angka
// (−$0.12, -0.24%), format tanggal/ISO, id (RSW-01, T-0419, NO-GO), kode.
//
// Catatan: fungsi ini hanya mengubah karakter pemisah menjadi "·" (middle
// dot) — TIDAK mengubah makna, TIDAK menghapus kata, dan tidak menyentuh
// angka (termasuk angka negatif, karena pola di bawah tidak menyentuh "-").

/** Em dash / en dash → middle dot. Minus (-) TIDAK disentuh. */
export function noDash(input: string): string {
  if (!input) return input;
  return input.replace(/[—–]/g, "·");
}

/**
 * Sama seperti noDash, tapi juga merapikan spasi ganda yang muncul setelah
 * penggantian (mis. "teks — teks" → "teks · teks").
 */
export function noDashText(input: string): string {
  if (!input) return input;
  return noDash(input).replace(/[ \t]{2,}/g, " ").trim();
}
