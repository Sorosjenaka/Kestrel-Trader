/** PAPER reporting day rolls over at 07:00 Asia/Jakarta (00:00 UTC). */
export const PAPER_DAY_TIME_ZONE = "Asia/Jakarta";
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PaperClosedTrade {
  createdAt: Date;
  pnlUsd: number;
  rMultiple: number;
  mode: string;
}

function summary(labelWib: string, from: Date, to: Date, rows: PaperClosedTrade[]) {
  const wins = rows.filter((row) => row.pnlUsd > 0).length;
  const sum = (values: number[]) => Number(values.reduce((a, b) => a + b, 0).toFixed(4));
  return {
    labelWib,
    fromUtc: from.toISOString(),
    toUtc: to.toISOString(),
    tradeCount: rows.length,
    wins,
    losses: rows.length - wins,
    winRatePct: rows.length ? Number((wins * 100 / rows.length).toFixed(1)) : null,
    netPnlUsd: sum(rows.map((row) => row.pnlUsd)),
    avgR: rows.length ? Number((sum(rows.map((row) => row.rMultiple)) / rows.length).toFixed(3)) : null,
    // 30 Sep 2026 — refactor SCALP-only: irisan SCALP tetap dilaporkan; trade
    // baris historis tetap tercakup di total `netPnlUsd`/`tradeCount`.
    byMode: {
      SCALP: { trades: rows.filter((row) => row.mode === "SCALP").length, netPnlUsd: sum(rows.filter((row) => row.mode === "SCALP").map((row) => row.pnlUsd)) },
      // 14 Okt 2026 — metode SWING-only: mode baru dilaporkan berdampingan.
      SWING: { trades: rows.filter((row) => row.mode === "SWING").length, netPnlUsd: sum(rows.filter((row) => row.mode === "SWING").map((row) => row.pnlUsd)) },
    },
  };
}

export interface PaperDaySession extends ReturnType<typeof summary> {
  /** Equity akhir sesi ini (start + kumulatif netPnlUsd sejak awal periode). */
  cumEquityUsd: number;
}

/** Rekap per sesi untuk SELURUH periode berjalan (sejak reset PAPER $200) —
 *  dipakai tabel "riwayat semua sesi" di dashboard history. Label sesi = tanggal
 *  UTC baris trade (cutover 00:00 UTC = 07:00 WIB), identik dengan snapshot
 *  harian dan grup tabel history. Semua angka deterministik dari baris yang sama. */
export function buildDailySessions(
  rows: PaperClosedTrade[],
  options: { startingEquityUsd: number; since?: Date | null } = { startingEquityUsd: 0 },
): PaperDaySession[] {
  const sinceMs = options.since && Number.isFinite(options.since.getTime()) ? options.since.getTime() : -Infinity;
  const valid = rows
    .filter((row) => Number.isFinite(row.createdAt.getTime()) && row.createdAt.getTime() >= sinceMs)
    .slice()
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const byLabel = new Map<string, PaperClosedTrade[]>();
  for (const row of valid) {
    const label = row.createdAt.toISOString().slice(0, 10);
    const bucket = byLabel.get(label);
    if (bucket) bucket.push(row);
    else byLabel.set(label, [row]);
  }
  let cumEquityUsd = Number((options.startingEquityUsd ?? 0).toFixed(4));
  const out: PaperDaySession[] = [];
  for (const label of [...byLabel.keys()].sort()) {
    const dayRows = byLabel.get(label)!;
    const first = dayRows[0]!.createdAt;
    const start = new Date(Math.max(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate()), sinceMs));
    const end = new Date(start.getTime() + DAY_MS);
    const s = summary(label, start, end, dayRows);
    cumEquityUsd = Number((cumEquityUsd + s.netPnlUsd).toFixed(4));
    out.push({ ...s, cumEquityUsd });
  }
  return out;
}

export function buildPaperDailySnapshot(rows: PaperClosedTrade[], now = new Date(), resetAt: Date | null = null) {
  if (!Number.isFinite(now.getTime())) throw new Error("INVALID_SNAPSHOT_TIME");
  // Jakarta has UTC+7; 07:00 WIB is exactly 00:00 UTC. UTC date here is the
  // local trading-day label, even between local midnight and 07:00.
  const cutoverMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const cutover = new Date(cutoverMs);
  const prior = new Date(cutoverMs - DAY_MS);
  const since = resetAt && Number.isFinite(resetAt.getTime()) ? resetAt.getTime() : -Infinity;
  const valid = rows.filter((row) => Number.isFinite(row.createdAt.getTime()) && row.createdAt.getTime() >= since && row.createdAt.getTime() <= now.getTime());
  const previousRows = valid.filter((row) => row.createdAt.getTime() >= prior.getTime() && row.createdAt.getTime() < cutoverMs);
  const currentRows = valid.filter((row) => row.createdAt.getTime() >= cutoverMs);
  const beforeCutover = valid.filter((row) => row.createdAt.getTime() < cutoverMs);
  return {
    timeZone: PAPER_DAY_TIME_ZONE,
    boundaryLocalTime: "07:00",
    asOfUtc: now.toISOString(),
    cutoverAtUtc: cutover.toISOString(),
    previous: summary(prior.toISOString().slice(0, 10), new Date(Math.max(prior.getTime(), since)), cutover, previousRows),
    current: summary(cutover.toISOString().slice(0, 10), new Date(Math.max(cutoverMs, since)), now, currentRows),
    cutoverSnapshot: {
      atUtc: cutover.toISOString(),
      closedTradeCountBeforeCutover: resetAt && resetAt.getTime() > cutoverMs ? null : beforeCutover.length,
      closedPaperNetPnlUsdBeforeCutover: resetAt && resetAt.getTime() > cutoverMs ? null : Number(beforeCutover.reduce((sum, row) => sum + row.pnlUsd, 0).toFixed(4)),
      scope: "PAPER closed trades only; open-position floating PnL and unclosed TP1 are excluded",
    },
  };
}
