import { beforeEach, describe, expect, it } from "vitest";
import {
  RUNTIME_PARAMS,
  clearAllRuntimeParams,
  isRuntimeSupported,
  runtimeParamsApplied,
} from "../src/config/runtimeParams";

describe("runtimeParams", () => {
  beforeEach(() => clearAllRuntimeParams());

  it("terdaftar: pullBiasThreshold, tp1R", () => {
    expect(Object.keys(RUNTIME_PARAMS).sort()).toEqual(["pullBiasThreshold", "tp1R"]);
  });

  it("validasi band bekerja", () => {
    expect(RUNTIME_PARAMS.tp1R?.validate(1.6)).toBe(1.6);
    expect(RUNTIME_PARAMS.tp1R?.validate(0.5)).toBeNull();
    expect(RUNTIME_PARAMS.pullBiasThreshold?.validate("abc")).toBeNull();
    expect(RUNTIME_PARAMS.pullBiasThreshold?.validate(9)).toBeNull();
  });

  it("parameter tak dikenal tidak didukung", () => {
    expect(isRuntimeSupported("maxLeverage")).toBe(false);
    expect(isRuntimeSupported("tp1R")).toBe(true);
  });

  it("apply mencatat penerapan", () => {
    expect(RUNTIME_PARAMS.pullBiasThreshold?.apply("SCALP", "S-02", 1.6, "v-test")).toBe(true);
    expect(runtimeParamsApplied()[0]).toMatchObject({ param: "pullBiasThreshold", value: 1.6 });
  });

  it("clear mengembalikan kondisi awal", () => {
    RUNTIME_PARAMS.pullBiasThreshold?.apply("SCALP", "S-02", 1.6, "v-test");
    clearAllRuntimeParams();
    expect(runtimeParamsApplied()).toHaveLength(0);
  });
});
