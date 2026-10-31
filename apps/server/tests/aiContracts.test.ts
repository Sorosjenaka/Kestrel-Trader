import { describe, expect, it } from "vitest";
import { parseTypedChoice, TYPED_CHOICES } from "../src/agents/aiContracts";

describe("aiContracts", () => {
  it("daftar pilihan bertipe tersedia untuk judge", () => {
    expect(TYPED_CHOICES.setupJudge).toEqual(expect.arrayContaining(["GO", "NO-GO"]));
  });
  it("JSON valid -> pilihan diterima + label sumber jujur", () => {
    const r = parseTypedChoice('{"choice":"GO","probabilities":{"GO":0.8,"NO-GO":0.2}}', TYPED_CHOICES.setupJudge, "NO-GO");
    expect(r.choice).toBe("GO");
    expect(r.valid).toBe(true);
    expect(r.source).toBe("llm");
  });
  it("teks kosong -> jatuh ke default fail-closed, sumber=fallback", () => {
    const r = parseTypedChoice("", TYPED_CHOICES.setupJudge, "NO-GO");
    expect(r.choice).toBe("NO-GO");
    expect(r.valid).toBe(false);
    expect(r.source).toBe("fallback");
  });
  it("pilihan di luar daftar -> jatuh ke default", () => {
    expect(parseTypedChoice('{"choice":"maybe"}', TYPED_CHOICES.setupJudge, "NO-GO").choice).toBe("NO-GO");
  });
  it("probabilitas dinormalisasi ke jumlah 1", () => {
    const r = parseTypedChoice('{"choice":"GO","probabilities":{"GO":3,"NO-GO":1}}', TYPED_CHOICES.setupJudge, "NO-GO");
    expect(r.probabilities.GO + r.probabilities["NO-GO"]).toBeCloseTo(1, 6);
    expect(r.probabilities.GO).toBeCloseTo(0.75, 6);
  });
});
