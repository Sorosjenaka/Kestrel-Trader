// apps/web/src/components/AlertFeedPanel.tsx — T-16 (CP-5, 19 Okt 2026).
// Panel alert kritis dari GET /api/alerts (EventLog warn/error/critical).
// Read-only; tidak ada tombol mutasi. Telegram tetap tidak dipakai.
import React, { useEffect, useState } from "react";
import { Panel, EmptyState } from "./ui.js";
import { colors, fonts } from "../theme.js";

export interface AlertItem {
  id: number;
  type: string;
  severity: string;
  createdAt: string;
  message: string;
}

function severityColor(severity: string): string {
  return severity === "warn" ? colors.accent : colors.down;
}

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }) : iso;
}

export function AlertFeedView({ items, error }: { items: AlertItem[]; error?: string | null }) {
  return (
    <Panel title={`ALERT KRITIS (${items.length})`}>
      {error ? (
        <EmptyState>Gagal membaca alert: {error}</EmptyState>
      ) : items.length === 0 ? (
        <EmptyState>Tidak ada alert severity warn/error/critical.</EmptyState>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {items.map((a) => (
            <div
              key={a.id}
              style={{
                display: "flex", gap: 10, alignItems: "baseline",
                borderLeft: `3px solid ${severityColor(a.severity)}`,
                background: colors.card, borderTop: `1px solid ${colors.border}`, borderRight: `1px solid ${colors.border}`, borderBottom: `1px solid ${colors.border}`, borderRadius: 2, padding: "6px 9px",
              }}
            >
              <span style={{ fontFamily: fonts.mono, fontSize: 10.5, color: severityColor(a.severity), minWidth: 64 }}>
                {a.severity.toUpperCase()}
              </span>
              <span style={{ flex: 1, fontSize: 12, color: colors.text }}>{a.message}</span>
              <span style={{ fontFamily: fonts.mono, fontSize: 10.5, color: colors.textMuted }}>{when(a.createdAt)}</span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

export function AlertFeedPanel() {
  const [items, setItems] = useState<AlertItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => {
      fetch("/api/alerts?limit=8")
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d) => { if (alive) { setItems(Array.isArray(d?.items) ? d.items : []); setError(null); } })
        .catch((e) => { if (alive) setError(e instanceof Error ? e.message : "unknown"); });
    };
    load();
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return <AlertFeedView items={items} error={error} />;
}
