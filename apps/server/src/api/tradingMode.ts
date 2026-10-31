import { getTradingStyle, type TradingStyle } from "../exec/slotFillPolicy.js";

export function configuredTradingModes(style: TradingStyle = getTradingStyle()) {
  return { scalp: style === "SCALP" || style === "BOTH", swing: style === "SWING" || style === "BOTH" };
}

/** Entry and preview must agree with the process mode; history remains readable in either mode. */
export function resolveEntryMode(requested: unknown, style: TradingStyle = getTradingStyle()):
  | { allowed: true; mode: "SCALP" | "SWING" }
  | { allowed: false; status: 400 | 403; error: string } {
  const mode = requested === undefined ? (style === "BOTH" ? "SCALP" : style) : requested;
  if (mode !== "SCALP" && mode !== "SWING") return { allowed: false, status: 400, error: "INVALID_TRADING_MODE" };
  if (style !== "BOTH" && mode !== style) return { allowed: false, status: 403, error: "TRADING_MODE_DISABLED" };
  return { allowed: true, mode };
}
