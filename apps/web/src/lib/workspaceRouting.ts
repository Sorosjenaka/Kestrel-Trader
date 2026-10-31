// apps/web/src/lib/workspaceRouting.ts
// Logika routing symbol untuk Terminal Workspace (23 Okt 2026).
//
// BUG ASLI ("symbol ter-revert"):
//   useEffect(() => {
//     if (!requestedSymbol) return;
//     setPanels((prev) => prev.map((p) => p.id === activeId ? { ...p, symbol: requestedSymbol.toUpperCase() } : p));
//   }, [requestedSymbol, activeId]);
//
// Effect itu punya `activeId` sebagai dependency, jadi setiap kali panel aktif
// BERGANTI (operator klik pair lain, atau pindah layout) effect tersebut
// MENIMPA KEMBALI symbol panel aktif dengan symbol dari route — yang biasanya
// sudah basi. Akibatnya pilihan operator langsung ditolak tanpa sebab.
//
// Aturan baru (fungsi murni di bawah, mudah diuji):
//   1. Symbol dari route hanya boleh diterapkan SATU KALI per nilai route.
//   2. Kalau route tidak punya symbol (undefined),(nextRouteSymbol) mengosongkan
//      penanda sehingga navigasi berikutnya boleh menerapkan lagi.
//   3. Perubahan symbol oleh operator (dropdown / klik tabel) TIDAK boleh
//      ditimpa effect route.

/** Hasil keputusan: symbol yang harus diterapkan, atau null = jangan terapkan. */
export interface RouteSymbolDecision {
  /** Symbol uppercase yang perlu di-set ke panel aktif, atau null. */
  symbol: string | null;
  /** Nilai penanda untuk menyimpan di ref (untuk panggilan berikutnya). */
  nextApplied: string | null;
}

/**
 * Tentukan apakah symbol dari route perlu diterapkan ke panel aktif.
 *
 * @param lastApplied  symbol route terakhir yang SUDAH diterapkan (null = belum pernah)
 * @param requested    symbol dari route sekarang (undefined = route tanpa symbol)
 */
export function nextRouteSymbol(
  lastApplied: string | null,
  requested: string | undefined,
): RouteSymbolDecision {
  if (!requested) return { symbol: null, nextApplied: null };
  const sym = requested.toUpperCase();
  if (lastApplied === sym) return { symbol: null, nextApplied: lastApplied };
  return { symbol: sym, nextApplied: sym };
}

/**
 * Terapkan symbol ke panel aktif pada daftar panel.
 * Panel lain tidak boleh tersentuh.
 */
export function applySymbolToPanel<T extends { id: string; symbol: string }>(
  panels: T[],
  activeId: string,
  symbol: string,
): T[] {
  return panels.map((p) => (p.id === activeId ? { ...p, symbol } : p));
}
