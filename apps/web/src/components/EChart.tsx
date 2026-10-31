import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import { init, use } from "echarts/core";
import type { EChartsOption } from "echarts";
import { CanvasRenderer } from "echarts/renderers";
import { LineChart, BarChart, HeatmapChart, ScatterChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  VisualMapComponent,
  MarkLineComponent,
  MarkPointComponent,
  DataZoomComponent,
} from "echarts/components";

use([
  CanvasRenderer,
  LineChart,
  BarChart,
  HeatmapChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  VisualMapComponent,
  MarkLineComponent,
  MarkPointComponent,
  DataZoomComponent,
]);

type Props = {
  option: EChartsOption;
  style?: CSSProperties;
  className?: string;
};

/**
 * Wrapper ECharts modular (Tahap 1 redesign Tema B).
 * init sekali di ref, setOption reaktif, ResizeObserver -> resize(),
 * dispose() di cleanup. Import hanya chart/komponen yang dipakai.
 */
export function EChart({ option, style, className }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReturnType<typeof init> | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = init(el);
    chartRef.current = chart;
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge: false });
  }, [option]);

  return <div ref={ref} style={style} className={className} />;
}