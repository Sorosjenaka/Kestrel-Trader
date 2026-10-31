// apps/web/src/lib/useMarkPrices.ts
//
// Hook React untuk feed mark price realtime (WS publik + fallback hub).
// Render dibatasi feed (~4x/dtk). Daftar simbol dinormalkan supaya urutan
// array baru tiap render tidak memicu reconnect.
import { useEffect, useMemo, useState } from "react";
import { markPriceFeed, type MarkFeedSnapshot } from "./markPriceFeed.js";

export function useMarkPrices(symbols: readonly string[]): MarkFeedSnapshot {
  const key = useMemo(
    () => [...new Set(symbols.map((s) => String(s ?? "").trim().toUpperCase()).filter(Boolean))].sort().join(","),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [symbols.join(",")],
  );
  const [snap, setSnap] = useState<MarkFeedSnapshot>(() => markPriceFeed.getSnapshot());
  useEffect(() => {
    if (!key) return;
    return markPriceFeed.subscribe(key.split(","), setSnap);
  }, [key]);
  return snap;
}
