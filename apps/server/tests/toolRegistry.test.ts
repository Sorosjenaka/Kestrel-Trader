import { describe, expect, it } from "vitest";
import { AGENT_TOOLS, isForbiddenToolName, listAgentTools } from "../src/agents/toolRegistry";

describe("toolRegistry", () => {
  it("hanya tool baca-saja yang terdaftar", () => {
    expect(Object.keys(AGENT_TOOLS).sort()).toEqual(["getKlines", "getLearningEntries", "queryStats"]);
  });

  it("tidak ada tool yang menyentuh order/arm/kill/parameter", () => {
    for (const name of Object.keys(AGENT_TOOLS)) {
      expect(isForbiddenToolName(name)).toBe(false);
    }
  });

  it("daftar forbidden bekerja untuk nama berbahaya", () => {
    expect(isForbiddenToolName("placeOrder")).toBe(true);
    expect(isForbiddenToolName("ARM_TRADING")).toBe(true);
    expect(isForbiddenToolName("killSwitch")).toBe(true);
    expect(isForbiddenToolName("setParameter")).toBe(true);
    expect(isForbiddenToolName("queryStats")).toBe(false);
  });

  it("setiap tool punya deskripsi", () => {
    for (const t of listAgentTools()) expect(t.description.length).toBeGreaterThan(10);
  });
});
