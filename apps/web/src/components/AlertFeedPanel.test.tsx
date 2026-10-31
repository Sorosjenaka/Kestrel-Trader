import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AlertFeedView } from "./AlertFeedPanel.js";

describe("AlertFeedView (T-16)", () => {
  it("menampilkan alert warn/error dengan pesan dan tanpa tombol mutasi", () => {
    const html = renderToStaticMarkup(<AlertFeedView items={[
      { id: 1, type: "ARM_BLOCKED_LIVE", severity: "warn", createdAt: "2026-10-19T00:00:00.000Z", message: "ARM diblokir" },
      { id: 2, type: "LIVE_DEPTH_REJECTED", severity: "error", createdAt: "2026-10-19T00:01:00.000Z", message: "depth kurang" },
    ]} />);
    expect(html).toContain("ALERT KRITIS (2)");
    expect(html).toContain("ARM diblokir");
    expect(html).toContain("depth kurang");
    expect(html).not.toContain("<button");
  });

  it("empty state dan error state eksplisit", () => {
    expect(renderToStaticMarkup(<AlertFeedView items={[]} />)).toContain("Tidak ada alert");
    expect(renderToStaticMarkup(<AlertFeedView items={[]} error="HTTP 500" />)).toContain("HTTP 500");
  });
});
