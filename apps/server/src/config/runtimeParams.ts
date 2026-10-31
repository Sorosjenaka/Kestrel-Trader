// TAHAP PROMOTE (checklist 2026-10-03 T-08). Allowlist parameter yang boleh
// menyentuh runtime. Golden Rules #9: hanya ParameterVersion yang lolos gate
// backtest yang boleh diterapkan; di luar daftar ini = tidak ada jalur runtime.
import { clearRuntimeTp1R, setRuntimeTp1R, type SetupMode } from "./setupEngine.js";
import { DEFAULT_LIQUIDITY_SNIPER_OPTIONS } from "../engines/indicatorLibrary.js";

export interface RuntimeParamDef {
  param: string;
  validate(value: unknown): number | null;
  apply(mode: SetupMode, strategyId: string, value: number, version: string): boolean;
  describe(value: number): string;
}

export interface AppliedParam {
  param: string;
  mode: SetupMode;
  strategyId: string;
  value: number;
  version: string;
}

const PULL_BIAS_BASE = DEFAULT_LIQUIDITY_SNIPER_OPTIONS.pullBiasThreshold;
let applied: AppliedParam[] = [];

function remember(entry: AppliedParam): void {
  applied = [...applied.filter((a) => a.param !== entry.param), entry];
}

function bounded(v: unknown, min: number, max: number): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

export const RUNTIME_PARAMS: Record<string, RuntimeParamDef> = {
  tp1R: {
    param: "tp1R",
    validate: (v) => bounded(v, 1.2, 6),
    apply: (mode, strategyId, value, version) => {
      const ok = setRuntimeTp1R(mode, strategyId, value, version);
      if (ok) remember({ param: "tp1R", mode, strategyId, value, version });
      return ok;
    },
    describe: (v) => `TP1_R ${v}`,
  },
  pullBiasThreshold: {
    param: "pullBiasThreshold",
    validate: (v) => bounded(v, 0.5, 3),
    apply: (mode, strategyId, value, version) => {
      if (mode !== "SCALP" || strategyId.toUpperCase() !== "S-02" || !Number.isFinite(value) || value < .5 || value > 3 || !version.trim()) return false;
      DEFAULT_LIQUIDITY_SNIPER_OPTIONS.pullBiasThreshold = value;
      remember({ param: "pullBiasThreshold", mode, strategyId, value, version });
      return true;
    },
    describe: (v) => `S-02 pullBiasThreshold ${v}`,
  },
};

export function isRuntimeSupported(param: unknown): boolean {
  return typeof param === "string" && Object.prototype.hasOwnProperty.call(RUNTIME_PARAMS, param);
}

export function isRuntimeTunable(param: unknown, mode: SetupMode, strategyId: string): boolean {
  return param === "pullBiasThreshold" && mode === "SCALP" && strategyId.toUpperCase() === "S-02";
}

export function runtimeParamsApplied(): AppliedParam[] {
  return applied.slice();
}

export function clearAllRuntimeParams(): void {
  applied = [];
  clearRuntimeTp1R();
  DEFAULT_LIQUIDITY_SNIPER_OPTIONS.pullBiasThreshold = PULL_BIAS_BASE;
}
