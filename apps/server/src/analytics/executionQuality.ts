// apps/server/src/analytics/executionQuality.ts — T-12 / CP-4 (19 Okt 2026).
// Analitik kualitas eksekusi dari fill ASLI (OrderExec): slippage realisasi vs
// harga order + latensi ack/fill. Murni; route /api/execution-quality yang
// membaca DB. Slippage positif = ADVERS (BUY lebih mahal / SELL lebih murah).

export interface FillRow {
  id: number;
  symbol: string;
  type: string;
  side: string;
  price: number;
  fillPrice: number | null;
  qty: number;
  feeUsd: number | null;
  simulated: boolean;
  createdAt: Date;
  filledAt: Date | null;
}

export interface QualityBucket {
  venue: "PAPER" | "LIVE";
  type: string;
  n: number;
  meanSlippageBps: number | null;
  medianSlippageBps: number | null;
  p95SlippageBps: number | null;
  meanLatencyMs: number | null;
  p95LatencyMs: number | null;
  sumFeeUsd: number;
}

/** Slippage bertanda dalam bps; null bila harga/fill tidak valid. */
export function signedSlippageBps(row: Pick<FillRow, "price" | "fillPrice" | "side">): number | null {
  const { price, fillPrice, side } = row;
  if (!Number.isFinite(price) || price <= 0 || fillPrice == null || !Number.isFinite(fillPrice) || fillPrice <= 0) {
    return null;
  }
  const direction = side.toUpperCase() === "BUY" ? 1 : side.toUpperCase() === "SELL" ? -1 : 0;
  if (direction === 0) return null;
  return ((fillPrice - price) / price) * 10_000 * direction;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** Kelompokkan per venue (simulated) + tipe order. */
export function summarizeExecutionQuality(rows: FillRow[]): QualityBucket[] {
  const groups = new Map<string, FillRow[]>();
  for (const row of rows) {
    const venue = row.simulated ? "PAPER" : "LIVE";
    const key = `${venue}|${row.type}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const out: QualityBucket[] = [];
  for (const [key, list] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const [venue, type] = key.split("|") as ["PAPER" | "LIVE", string];
    const slips = list.map(signedSlippageBps).filter((v): v is number => v != null);
    const latencies = list
      .filter((r) => r.filledAt != null)
      .map((r) => r.filledAt!.getTime() - r.createdAt.getTime())
      .filter((v) => Number.isFinite(v) && v >= 0);
    out.push({
      venue,
      type,
      n: list.length,
      meanSlippageBps: mean(slips),
      medianSlippageBps: percentile(slips, 50),
      p95SlippageBps: percentile(slips, 95),
      meanLatencyMs: mean(latencies),
      p95LatencyMs: percentile(latencies, 95),
      sumFeeUsd: list.reduce((s, r) => s + (Number.isFinite(r.feeUsd) ? (r.feeUsd as number) : 0), 0),
    });
  }
  return out;
}
