// apps/server/src/agents/decisionVeto.ts
// VETO NO-GO: penolakan agen harus DIINGAT selama masa berlaku, supaya kandidat
// yang sama tidak mendapat GO deterministik beberapa menit setelah ditolak
// (temuan audit 26 Sep 2026 baris 304: "NO-GO tidak disimpan sebagai veto").
// Pola mengikuti cooldown yang sudah ada di exec/slotFillPolicy.ts.
export const VETO_TTL_MS = 3 * 60_000;

export interface VetoEntry {
  reason: string;
  atMs: number;
}

export interface VetoTarget {
  symbol: string;
  strategyId: string;
  side: string;
}

const entries = new Map<string, VetoEntry>();

export const decisionVeto = {
  keyOf(p: VetoTarget): string {
    return `${p.symbol}:${p.strategyId}:${String(p.side).toUpperCase()}`;
  },
  recordNoGo(key: string, reason: string, nowMs = Date.now()): void {
    entries.set(key, { reason: reason.slice(0, 200), atMs: nowMs });
  },
  isBlocked(key: string, nowMs = Date.now(), ttlMs = VETO_TTL_MS): boolean {
    const e = entries.get(key);
    return Boolean(e && nowMs - e.atMs < ttlMs);
  },
  reasonFor(key: string): string | null {
    return entries.get(key)?.reason ?? null;
  },
  clear(): void {
    entries.clear();
  },
};
