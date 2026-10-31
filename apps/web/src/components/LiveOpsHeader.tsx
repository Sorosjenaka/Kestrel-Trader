// apps/web/src/components/LiveOpsHeader.tsx
//
// 30 Okt 2026 (koreksi operator poin 3): header ARTATRADE OPS + tab OPS.
// Control Room tidak lagi halaman terpisah — NETWORK / GRID / LACAK TRADE
// hidup sebagai tab di halaman Live, tepat di bawah header ini.
// Header tetap jujur: mode & ARM dibaca dari /api/live/mesh, bukan hardcode.
import { useEffect, useState } from "react";

export type OpsTab = "live" | "network" | "grid" | "lacak";

const TABS: Array<{ id: OpsTab; label: string }> = [
  { id: "live", label: "LIVE" },
  { id: "network", label: "NETWORK" },
  { id: "grid", label: "GRID" },
  { id: "lacak", label: "LACAK TRADE" },
];

export function LiveOpsHeader({ tab, onTab }: { tab: OpsTab; onTab: (t: OpsTab) => void }) {
  const [mode, setMode] = useState<{ executionMode: string; armed: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (!alive || document.visibilityState === "hidden") { timer = setTimeout(load, 5000); return; }
      try {
        const r = await fetch("/api/live/mesh", { cache: "no-store" });
        if (r.ok) {
          const d = await r.json() as { executionMode?: string; armed?: boolean };
          if (alive) setMode({ executionMode: String(d.executionMode ?? "·"), armed: Boolean(d.armed) });
        }
      } catch { /* badge tetap "…" — tidak menebak status */ }
      if (alive) timer = setTimeout(load, 5000);
    };
    load();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, []);

  return (
    <div className="live-ops-header">
      <div className="live-ops-brandline">
        <span className="live-ops-mark" aria-hidden="true"><i /><i /></span>
        <span className="live-ops-title">ARTATRADE OPS</span>
        <span className="live-ops-sub">live / artatrade-prod</span>
        <div style={{ flex: 1 }} />
        <span className={`live-ops-mode${mode?.executionMode === "LIVE" ? " live" : ""}`}>
          <i /> {mode ? `${mode.executionMode} · ARM ${mode.armed ? "ON" : "OFF"}` : "…"}
        </span>
        <span className="live-ops-ro">READ-ONLY</span>
      </div>
      <nav className="live-ops-tabs" role="tablist" aria-label="Ops sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`live-ops-tab${tab === t.id ? " active" : ""}`}
            onClick={() => onTab(t.id)}
          >
            {t.label}
          </button>
        ))}
        <span className="live-ops-tab-note">
          {tab === "live" ? "dashboard posisi & chart" : "system transparency · read-only"}
        </span>
      </nav>
    </div>
  );
}
