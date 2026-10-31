export type TradingMode = "SCALP" | "SWING";
export type HistoryMode = TradingMode | "ALL";

export function historyUrl(mode: string): string {
  return `/api/trades?mode=${mode === "SCALP" || mode === "SWING" ? mode : "ALL"}`;
}

export function enabledTradingModes(modes: unknown): TradingMode[] {
  if (!modes || typeof modes !== "object") return [];
  const value = modes as Record<string, unknown>;
  return (["SCALP", "SWING"] as const).filter(mode => value[mode.toLowerCase()] === true);
}

export function resolveTradingMode(preferred: unknown, enabled: TradingMode[]): TradingMode | null {
  return enabled.find(mode => mode === preferred) ?? enabled[0] ?? null;
}
