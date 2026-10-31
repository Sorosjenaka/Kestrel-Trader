import { Suspense, lazy } from "react";
import { Tabs } from "../components/ui.js";

// 24 Okt 2026 — pemuatan cepat: sub-tab research dimuat terpisah supaya
// membuka "Evaluation" tidak ikut mengunduh Lab/Backtest/Learning.
const BacktestPage = lazy(() => import("./BacktestPage.js").then((m) => ({ default: m.BacktestPage })));
const LabPage = lazy(() => import("./LabPage.js").then((m) => ({ default: m.LabPage })));
const LearningPage = lazy(() => import("./LearningPage.js").then((m) => ({ default: m.LearningPage })));
const SwingEvalLoopPanel = lazy(() => import("../components/SwingEvalLoopPanel.js").then((m) => ({ default: m.SwingEvalLoopPanel })));

export type ResearchSub = "evaluation" | "backtest" | "lab" | "learning";

function TabFallback() {
  return (
    <div style={{ padding: "40px 16px", textAlign: "center", fontSize: 12, letterSpacing: "0.12em" }}>
      MEMUAT MODUL…
    </div>
  );
}

export function ResearchPage({ sub = "evaluation", onSub }: { sub?: string; onSub: (s: ResearchSub) => void }) {
  const active = (["evaluation", "backtest", "lab", "learning"].includes(sub) ? sub : "evaluation") as ResearchSub;
  return (
    <div className="page">
      <Tabs
        value={active}
        onChange={onSub}
        tabs={[
          { id: "evaluation", label: "Evaluation" },
          { id: "backtest", label: "Backtest" },
          { id: "lab", label: "Lab" },
          { id: "learning", label: "Learning" },
        ]}
      />
      <div className="tab-content">
        <Suspense fallback={<TabFallback />}>
          {active === "backtest" ? <BacktestPage /> : active === "lab" ? <LabPage /> : active === "learning" ? <LearningPage /> : <SwingEvalLoopPanel />}
        </Suspense>
      </div>
    </div>
  );
}
