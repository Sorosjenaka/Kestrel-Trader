import { Suspense, lazy } from "react";
import { Tabs } from "../components/ui.js";

// 24 Okt 2026 — pemuatan cepat: sub-tab market dimuat terpisah.
// MarketPage menarik lightweight-charts (~169 kB) yang TIDAK diperlukan
// untuk tab Heatmap/Screener — memuatnya eager membuat buka "Markets"
// selalu membayar 169 kB ekstra.
const MarketPage = lazy(() => import("./MarketPage.js").then((m) => ({ default: m.MarketPage })));
const MarketsPage = lazy(() => import("./MarketsPage.js").then((m) => ({ default: m.MarketsPage })));
const HeatmapPage = lazy(() => import("./HeatmapPage.js").then((m) => ({ default: m.HeatmapPage })));

export type MarketSub = "overview" | "screener" | "heatmap";

function TabFallback() {
  return (
    <div style={{ padding: "40px 16px", textAlign: "center", fontSize: 12, letterSpacing: "0.12em" }}>
      MEMUAT MODUL…
    </div>
  );
}

export function MarketHubPage({ sub = "overview", onSub }: { sub?: string; onSub: (s: MarketSub) => void }) {
  const active = (["overview", "screener", "heatmap"].includes(sub) ? sub : "overview") as MarketSub;
  return (
    <div className="page">
      <Tabs
        value={active}
        onChange={onSub}
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "screener", label: "Screener" },
          { id: "heatmap", label: "Heatmap" },
        ]}
      />
      <div className="tab-content">
        <Suspense fallback={<TabFallback />}>
          {active === "screener" ? <MarketsPage /> : active === "heatmap" ? <HeatmapPage /> : <MarketPage />}
        </Suspense>
      </div>
    </div>
  );
}
