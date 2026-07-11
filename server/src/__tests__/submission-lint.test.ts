import { describe, expect, it } from "vitest";
import { lintTaskSpecs } from "../submission-lint";

describe("GPU reservation submission lint", () => {
  it("warns when GPU work has neither memory reservation nor explicit exclusivity", () => {
    const warnings = lintTaskSpecs([{
      ref: "train",
      script: "/bin/python",
      requirements: { gpu_type: ["A30"] },
    }]);

    expect(warnings).toContainEqual(expect.objectContaining({
      code: "gpu_memory_unreserved",
      ref: "train",
      field: "requirements.gpu_mem_mb",
    }));
  });

  it("accepts explicit GPU exclusivity without a memory estimate", () => {
    const warnings = lintTaskSpecs([{
      ref: "train",
      script: "/bin/python",
      requirements: { gpu_type: ["A30"], exclusive_gpu: true },
    }]);

    expect(warnings.find((warning) => warning.code === "gpu_memory_unreserved")).toBeUndefined();
  });

  it("warns about non-positive memory declarations", () => {
    const warnings = lintTaskSpecs([{
      ref: "train",
      script: "/bin/python",
      requirements: { gpu_mem_mb: -1 },
    }]);

    expect(warnings).toContainEqual(expect.objectContaining({
      code: "invalid_resource_requirement",
      field: "requirements.gpu_mem_mb",
    }));
  });
});
