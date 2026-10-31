// apps/server/src/analytics/prometheusMetrics.ts — T-15 / CP-5 (19 Okt 2026).
// Renderer Prometheus text murni (tanpa dependency, tanpa LLM). Route /metrics
// mengumpulkan snapshot dari DB/guard lalu memanggil fungsi ini.
// Cardinality dijaga rendah: tidak ada label per simbol/trade.

export interface MetricsSnapshot {
  executionMode: string;
  /** liveReady = LIVE + ARM; di PAPER selalu false. */
  liveReady: boolean;
  /** ARM saat ini (di PAPER = arm simulasi; di LIVE hard-block false). */
  armed: boolean;
  openPositions: number;
  closedTradesToday: number;
  pnlTodayUsd: number;
  winRateTodayPct: number | null;
  eventCountsBySeverity: Record<string, number>;
  lastTradeAgeSeconds: number | null;
  uptimeSeconds: number;
  dbSizeBytes: number | null;
}

function num(v: number | null, digits = 4): string {
  if (v == null || !Number.isFinite(v)) return "0";
  return Number(v.toFixed(digits)).toString();
}

function label(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** Format Prometheus exposition text (v0.0.4). Deterministik, urutan tetap. */
export function renderPrometheusMetrics(s: MetricsSnapshot): string {
  const lines: string[] = [];
  const add = (name: string, help: string, type: "gauge" | "counter", body: string[]): void => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
    lines.push(...body);
  };

  add("artatrade_up", "Server process is serving metrics.", "gauge", ["artatrade_up 1"]);
  add("artatrade_process_uptime_seconds", "Process uptime in seconds.", "gauge", [
    `artatrade_process_uptime_seconds ${num(s.uptimeSeconds, 0)}`,
  ]);
  add("artatrade_execution_mode", "Active execution mode (label always 1).", "gauge", [
    `artatrade_execution_mode{mode="${label(s.executionMode)}"} 1`,
  ]);
  add("artatrade_live_ready", "1 only when mode=LIVE AND ARM is on (hard-blocked in LIVE).", "gauge", [
    `artatrade_live_ready ${s.liveReady ? 1 : 0}`,
  ]);
  add("artatrade_armed", "Current ARM state (paper arm in PAPER mode).", "gauge", [
    `artatrade_armed ${s.armed ? 1 : 0}`,
  ]);
  add("artatrade_open_positions", "Open positions tracked in DB.", "gauge", [
    `artatrade_open_positions ${num(s.openPositions, 0)}`,
  ]);
  add("artatrade_closed_trades_today", "Closed trades since local midnight.", "gauge", [
    `artatrade_closed_trades_today ${num(s.closedTradesToday, 0)}`,
  ]);
  add("artatrade_pnl_today_usd", "NET pnl of closed trades since local midnight (USD).", "gauge", [
    `artatrade_pnl_today_usd ${num(s.pnlTodayUsd)}`,
  ]);
  if (s.winRateTodayPct != null && Number.isFinite(s.winRateTodayPct)) {
    add("artatrade_winrate_today_pct", "Win rate of closed trades today (percent).", "gauge", [
      `artatrade_winrate_today_pct ${num(s.winRateTodayPct, 2)}`,
    ]);
  }
  add("artatrade_event_total", "EventLog rows by severity (all time).", "counter",
    Object.entries(s.eventCountsBySeverity)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([sev, count]) => `artatrade_event_total{severity="${label(sev)}"} ${num(count, 0)}`));
  if (s.lastTradeAgeSeconds != null && Number.isFinite(s.lastTradeAgeSeconds)) {
    add("artatrade_last_trade_age_seconds", "Age of the most recent closed trade.", "gauge", [
      `artatrade_last_trade_age_seconds ${num(s.lastTradeAgeSeconds, 0)}`,
    ]);
  }
  if (s.dbSizeBytes != null && Number.isFinite(s.dbSizeBytes)) {
    add("artatrade_db_size_bytes", "SQLite database file size.", "gauge", [
      `artatrade_db_size_bytes ${num(s.dbSizeBytes, 0)}`,
    ]);
  }
  return `${lines.join("\n")}\n`;
}
