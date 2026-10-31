// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { AppErrorBoundary } from "./AppErrorBoundary.js";

function BrokenPage(): React.ReactNode {
  throw new Error("page render failed");
}

describe("AppErrorBoundary", () => {
  beforeEach(() => cleanup());

  it("keeps a page failure inside an explicit console fallback", () => {
    render(
      <AppErrorBoundary>
        <BrokenPage />
      </AppErrorBoundary>,
    );

    expect(screen.getByRole("alert").textContent).toContain("Konsol gagal dimuat");
    expect(screen.getByRole("button", { name: "Muat ulang konsol" })).toBeTruthy();
  });
});
