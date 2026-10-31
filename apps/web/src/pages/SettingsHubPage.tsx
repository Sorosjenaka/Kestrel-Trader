import { Suspense, lazy } from "react";
import { Tabs } from "../components/ui.js";

// 24 Okt 2026 — pemuatan cepat: sub-tab settings dimuat terpisah.
const SettingsPage = lazy(() => import("./SettingsPage.js").then((m) => ({ default: m.SettingsPage })));
const UniversePage = lazy(() => import("./UniversePage.js").then((m) => ({ default: m.UniversePage })));
// 27 Okt 2026 — LiveLockedPage diganti dashboard LIVE (exposure riil exchange).
// Halaman lama hanya menampilkan "akses dinonaktifkan".
const LiveLiveOnlyPage = lazy(() => import("./LiveLiveOnlyPage.js").then((m) => ({ default: m.LiveLiveOnlyPage })));

export type SettingsSub = "settings" | "universe" | "live";

function TabFallback() {
  return (
    <div style={{ padding: "40px 16px", textAlign: "center", fontSize: 12, letterSpacing: "0.12em" }}>
      MEMUAT MODUL…
    </div>
  );
}

export function SettingsHubPage({ sub = "settings", onSub }: { sub?: string; onSub: (s: SettingsSub) => void }) {
  const active = (["settings", "universe", "live"].includes(sub) ? sub : "settings") as SettingsSub;
  return (
    <div className="page">
      <Tabs
        value={active}
        onChange={onSub}
        tabs={[
          { id: "settings", label: "Settings" },
          { id: "universe", label: "Universe" },
          { id: "live", label: "Live" },
        ]}
      />
      <div className="tab-content">
        <Suspense fallback={<TabFallback />}>
          {active === "universe" ? <UniversePage /> : active === "live" ? <LiveLiveOnlyPage /> : <SettingsPage />}
        </Suspense>
      </div>
    </div>
  );
}
