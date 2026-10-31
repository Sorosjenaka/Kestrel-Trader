// apps/server/src/analytics/alertFeed.ts — T-16 / CP-5 (19 Okt 2026).
// Feed alert kritis dari EventLog untuk dashboard (Telegram TIDAK dipakai).
// Murni pemetaan + filter; route /api/alerts yang membaca DB.

export interface EventLogLike {
  id: number;
  type: string;
  severity: string;
  payload: string;
  createdAt: Date;
}

export interface AlertItem {
  id: number;
  type: string;
  severity: string;
  createdAt: string;
  message: string;
  payload: Record<string, unknown>;
}

export const ALERT_SEVERITIES = ["warn", "error", "critical"] as const;

export function isAlertSeverity(severity: string): boolean {
  return (ALERT_SEVERITIES as readonly string[]).includes(severity);
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function firstText(payload: Record<string, unknown>): string | null {
  for (const key of ["message", "reason", "error", "detail", "note"]) {
    const v = payload[key];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

/** Satu baris EventLog -> item alert yang aman ditampilkan (payload ter-truncate). */
export function toAlertItem(row: EventLogLike): AlertItem {
  const payload = parsePayload(row.payload);
  const detail = firstText(payload);
  const message = detail ? `${row.type}: ${detail}` : row.type;
  const safePayload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    safePayload[k] = typeof v === "string" && v.length > 300 ? `${v.slice(0, 300)}…` : v;
  }
  return {
    id: row.id,
    type: row.type,
    severity: row.severity,
    createdAt: row.createdAt.toISOString(),
    message: message.length > 500 ? `${message.slice(0, 500)}…` : message,
    payload: safePayload,
  };
}

/** Filter severity + urutan terbaru + batas. Input diasumsikan sudah desc dari DB. */
export function buildAlertFeed(rows: EventLogLike[], limit = 20): AlertItem[] {
  const cap = Math.max(1, Math.min(100, Math.trunc(limit)));
  return rows
    .filter((r) => isAlertSeverity(r.severity))
    .slice(0, cap)
    .map(toAlertItem);
}
