// apps/server/src/learning/linkPositionIds.ts — T0.3 (18 Okt 2026): tautkan positionId.
//
// Masalah (audit 18 Okt 2026): Learning loop terputus karena `positionId` pada
// DecisionLog & SwingSignalLog bernilai NULL untuk seluruh baris historis.
// Dua sebab:
//   (1) Baris historis ditulis SEBELUM kode taut (linkDecisionToPosition /
//       logSwingSignal(..., positionId)) mendarat — 11 ENTRY_OPENED di
//       SwingSignalLog semuanya NULL, walau 3 di antaranya masih punya Position
//       hidup (AVAX#3176, SUI#3177, ASR#3178).
//   (2) Sebagian Position sudah hilang oleh history-reset (FK onDelete: SetNull),
//       jadi 8 ENTRY_OPENED sisanya TIDAK bisa dipulihkan — dibiarkan NULL,
//       jangan pernah mengarang kaitan.
//
// Jalur forward (entry baru) sudah benar dan tidak diubah di sini. Modul ini
// hanya MEMULIHKAN kaitan yang bisa dipastikan, secara idempoten:
//   - hanya mengisi kolom yang masih NULL (tidak pernah menimpa kaitan ada);
//   - hanya menautkan pada kecocokan TUNGGAL & eksplisit; kalau ragu → biarkan
//     NULL dan catat sebagai UNLINKED (lebih baik kosong daripada salah taut).
//
// KONTRAK DB (lihat costs.ts): positionId adalah FK -> Position.id. Learning
// loop JOIN DecisionLog/SwingSignalLog -> Position -> Trade lewat positionId
// (Trade.positionId unik per Position). Tanpa angka uang (Golden Rule §1.1).

/** Satu baris log yang perlu ditautkan (subset kolom, bebas DB agar mudah diuji). */
export interface LinkableLogRow {
  id: number;
  symbol: string;
  side: string;
  strategyId: string | null;
  /** Hanya SwingSignalLog yang menyimpan harga; DecisionLog null. */
  entryPrice: number | null;
  /** Epoch ms (createdAt baris log). */
  createdAtMs: number;
  positionId: number | null;
}

/** Posisi kandidat dari tabel Position. */
export interface LinkablePositionRow {
  id: number;
  symbol: string;
  side: string;
  strategyId: string | null;
  entryPrice: number;
  /** Epoch ms (openedAt posisi). */
  openedAtMs: number;
}

export interface MatchOptions {
  /** Toleransi harga relatif (default 0.001 = 0,1%). Menampung pembulatan entryPrice Position. */
  priceTolerance?: number;
  /** Jendela waktu |createdAt - openedAt| dalam ms (default 120_000 = 2 menit). */
  timeWindowMs?: number;
}

/** Hasil pemetaan satu baris log ke sebuah Position. */
export type MatchResult =
  | { kind: "MATCHED"; positionId: number }
  | { kind: "UNLINKED"; reason: "AMBIGUOUS" | "NO_CANDIDATE" | "ALREADY_LINKED" };

const DEFAULT_PRICE_TOLERANCE = 0.001;
const DEFAULT_TIME_WINDOW_MS = 120_000;

function normalizeSide(side: string): string {
  return String(side ?? "").toUpperCase();
}
function normalizeSymbol(symbol: string): string {
  return String(symbol ?? "").toUpperCase();
}

function priceClose(a: number | null, b: number, tolerance: number): boolean {
  // Tanpa harga pada baris log (DecisionLog) -> harga bukan pemisah; andalkan
  // symbol+side+strategyId+time. Dengan harga (SwingSignalLog) -> wajib dekat.
  if (a == null || !Number.isFinite(a)) return true;
  if (!Number.isFinite(b) || b <= 0) return false;
  return Math.abs(a - b) / Math.abs(b) <= tolerance;
}

/**
 * Peta satu baris log ke Position. Hanya kecocokan TUNGGAL yang dikembalikan.
 * Nol kandidat -> NO_CANDIDATE; lebih dari satu -> AMBIGUOUS (biarkan NULL).
 */
export function matchToPosition(
  row: LinkableLogRow,
  positions: LinkablePositionRow[],
  opts: MatchOptions = {}
): MatchResult {
  if (row.positionId != null) return { kind: "UNLINKED", reason: "ALREADY_LINKED" };
  const priceTolerance = opts.priceTolerance ?? DEFAULT_PRICE_TOLERANCE;
  const timeWindowMs = opts.timeWindowMs ?? DEFAULT_TIME_WINDOW_MS;
  const symbol = normalizeSymbol(row.symbol);
  const side = normalizeSide(row.side);

  const candidates = positions.filter((p) => {
    if (p.id == null) return false;
    if (normalizeSymbol(p.symbol) !== symbol) return false;
    if (normalizeSide(p.side) !== side) return false;
    // strategyId harus persis (termasuk null <-> null) agar tidak salah taut
    // antar strategi pada simbol yang sama.
    if ((p.strategyId ?? null) !== (row.strategyId ?? null)) return false;
    if (!Number.isFinite(p.openedAtMs) || Math.abs(row.createdAtMs - p.openedAtMs) > timeWindowMs) return false;
    return priceClose(row.entryPrice, p.entryPrice, priceTolerance);
  });

  if (candidates.length === 1) return { kind: "MATCHED", positionId: candidates[0].id };
  if (candidates.length > 1) return { kind: "UNLINKED", reason: "AMBIGUOUS" };
  return { kind: "UNLINKED", reason: "NO_CANDIDATE" };
}

/** Susun rencana taut untuk sekelompok baris log. Setiap Position diklaim maksimal
 *  satu kali (greedy berdasarkan urutan input) agar tidak double-link. */
export function planLinks(
  rows: LinkableLogRow[],
  positions: LinkablePositionRow[],
  opts: MatchOptions = {}
): { updates: { logId: number; positionId: number }[]; unlinked: { logId: number; reason: string }[] } {
  const claimed = new Set<number>();
  const updates: { logId: number; positionId: number }[] = [];
  const unlinked: { logId: number; reason: string }[] = [];
  for (const row of rows) {
    const available = positions.filter((p) => !claimed.has(p.id));
    const res = matchToPosition(row, available, opts);
    if (res.kind === "MATCHED") {
      claimed.add(res.positionId);
      updates.push({ logId: row.id, positionId: res.positionId });
    } else {
      unlinked.push({ logId: row.id, reason: res.reason });
    }
  }
  return { updates, unlinked };
}

/** Konversi Date | string | number -> epoch ms (NaN bila tak terbaca). */
export function toEpochMs(value: Date | string | number | null | undefined): number {
  if (value == null) return Number.NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : Number.NaN;
}
