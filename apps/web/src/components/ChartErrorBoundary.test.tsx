// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, beforeEach } from "vitest";
import { ChartErrorBoundary } from "./ChartErrorBoundary.js";

let shouldThrow = true;

function ThrowingChart() {
  if (shouldThrow) throw new Error("chart render failed");
  return <div>chart recovered</div>;
}

describe("ChartErrorBoundary", () => {
  beforeEach(() => {
    cleanup();
    shouldThrow = true;
  });

  it("isolates a chart render failure behind a reload control", () => {
    render(
      <ChartErrorBoundary>
        <ThrowingChart />
      </ChartErrorBoundary>,
    );

    expect(screen.getByRole("alert").textContent).toContain("Chart gagal dimuat");
    expect(screen.getByRole("button", { name: "Muat ulang chart" })).toBeTruthy();
  });

  it("remounts the chart after the operator clicks reload", () => {
    render(
      <ChartErrorBoundary>
        <ThrowingChart />
      </ChartErrorBoundary>,
    );

    shouldThrow = false;
    fireEvent.click(screen.getByRole("button", { name: "Muat ulang chart" }));
    expect(screen.getByText("chart recovered")).toBeTruthy();
  });
});
