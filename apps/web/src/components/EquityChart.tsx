// apps/web/src/components/EquityChart.tsx — kurva equity via ECharts (Tema B).
// Menggantikan EquityCurve SVG untuk tampilan yang lebih kaya.
import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { EChart } from "./EChart.js";
import { colors } from "../theme.js";

export interface EquityTradePoint {
  createdAt: string;
  pnlUsd: number;
}

export function EquityChart({
  startEquity,
  trades,
  currentEquity,
  height = 200,
}: {
  startEquity: number;
  trades: EquityTradePoint[];
  currentEquity: number | null;
  height?: number;
}) {
  const option = useMemo<EChartsOption>(() => {
    const ordered = [...trades].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const values: number[] = [startEquity];
    let run = startEquity;
    for (const t of ordered) {
      run = Number((run + t.pnlUsd).toFixed(4));
      values.push(run);
    }
    if (currentEquity != null && Number.isFinite(currentEquity)) values.push(currentEquity);

    const last = values[values.length - 1] ?? startEquity;
    const up = last >= startEquity;
    const lineColor = up ? colors.up : colors.down;

    return {
      backgroundColor: "transparent",
      animationDuration: 600,
      grid: { left: 50, right: 14, top: 14, bottom: 22 },
      xAxis: {
        type: "category",
        data: values.map((_, i) => String(i)),
        boundaryGap: false,
        axisLabel: { show: false },
        splitLine: { show: false },
        axisLine: { lineStyle: { color: colors.borderLight } },
        axisTick: { show: false },
      },
      yAxis: {
        type: "value",
        scale: true,
        axisLabel: { color: colors.textDim, fontSize: 10, formatter: (v: number) => `$${v.toFixed(0)}` },
        splitLine: { lineStyle: { color: colors.border } },
        axisLine: { show: false },
        axisTick: { show: false },
      },
      tooltip: {
        trigger: "axis",
        backgroundColor: colors.bgPanel,
        borderColor: colors.borderLight,
        textStyle: { color: colors.text, fontSize: 11, fontFamily: "'JetBrains Mono', monospace" },
        valueFormatter: (v: any) => `$${Number(v).toFixed(2)}`,
      },
      series: [
        {
          type: "line",
          data: values,
          showSymbol: false,
          smooth: 0.2,
          lineStyle: { width: 1.6, color: lineColor },
          areaStyle: {
            color: {
              type: "linear",
              x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: lineColor + "55" },
                { offset: 1, color: lineColor + "00" },
              ],
            },
          },
          markLine: {
            symbol: "none",
            silent: true,
            lineStyle: { color: colors.borderLight, type: "dashed" },
            label: { show: false },
            data: [{ yAxis: startEquity }],
          },
          markPoint: {
            symbol: "circle",
            symbolSize: 7,
            itemStyle: { color: colors.accent },
            label: { show: false },
            data: [{ name: "current", coord: [values.length - 1, last] }],
          },
        },
      ],
    };
  }, [startEquity, trades, currentEquity]);

  return <EChart option={option} style={{ height, width: "100%" }} />;
}