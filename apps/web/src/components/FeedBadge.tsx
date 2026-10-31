// apps/web/src/components/FeedBadge.tsx
//
// Badge status feed mark price: LIVE (WS publik segar) atau DELAYED (fallback
// hub backend / WS putus). Operator harus bisa membedakan angka realtime dari
// angka cadangan — jangan pernah menampilkan badge hijau/cyan saat fallback.
import { colors, fonts } from "../theme.js";
import type { FeedStatus } from "../lib/markPriceFeed.js";

export function FeedBadge({ status, title }: { status: FeedStatus; title?: string }) {
  const live = status === "LIVE";
  return (
    <span
      title={
        title ??
        (live
          ? "Mark price dari WebSocket publik Binance Futures (<= 3 dtk)"
          : "WS publik tidak terhubung — memakai hub harga backend (~1 dtk)")
      }
      style={{
        fontSize: 9.5,
        fontWeight: 700,
        letterSpacing: "0.08em",
        padding: "2px 6px",
        borderRadius: 2,
        border: `1px solid ${live ? colors.up : colors.warn}`,
        color: live ? colors.up : colors.warn,
        background: live ? colors.upBg : colors.warnBg,
        fontFamily: fonts.mono,
        whiteSpace: "nowrap",
      }}
    >
      {status}
    </span>
  );
}
