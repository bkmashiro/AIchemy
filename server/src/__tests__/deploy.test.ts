import { describe, expect, it } from "vitest";
import { buildSlurmStubScript } from "../deploy";
import { StubTarget } from "../types";

function makeSlurmTarget(overrides: Partial<StubTarget> = {}): StubTarget {
  return {
    name: "a30",
    type: "slurm",
    host: "gpucluster2",
    ssh_host: "gpucluster2",
    remote_dir: "/vol/bitbucket/ys25/alchemy-stub",
    python_path: "python",
    max_concurrent: 1,
    partition: "gpgpu",
    gres: "gpu:1",
    mem: "60G",
    time: "24:00:00",
    tags: "a30,slurm",
    default_cwd: "/vol/bitbucket/ys25/jema-v2",
    ...overrides,
  };
}

describe("SLURM deploy script generation", () => {
  it("includes idle timeout from CLI/API overrides", () => {
    const script = buildSlurmStubScript(
      makeSlurmTarget(),
      "https://alchemy-v2.yuzhes.com",
      "secret-token",
      { idle_timeout: 600, mem: "80G", time: "2-00:00:00" },
    );

    expect(script).toContain("#SBATCH --mem=80G");
    expect(script).toContain("#SBATCH --time=2-00:00:00");
    expect(script).toContain("  --idle-timeout 600");
    expect(script).toContain("  --default-cwd \"/vol/bitbucket/ys25/jema-v2\" \\");
    expect(script).toContain("  --tags \"a30,slurm\" \\");
  });

  it("uses idle timeout from deploy config when no override is provided", () => {
    const script = buildSlurmStubScript(
      makeSlurmTarget({ idle_timeout: 300 }),
      "https://alchemy-v2.yuzhes.com",
      "secret-token",
    );

    expect(script).toContain("  --idle-timeout 300");
  });

  it("includes default output dir from deploy config", () => {
    const script = buildSlurmStubScript(
      makeSlurmTarget({ default_output_dir: "/vol/gpudata/ys25-MySpace/alchemy-runs" }),
      "https://alchemy-v2.yuzhes.com",
      "secret-token",
    );

    expect(script).toContain("  --default-output-dir \"/vol/gpudata/ys25-MySpace/alchemy-runs\"");
  });

  it("lets API overrides replace deploy-config default output dir", () => {
    const script = buildSlurmStubScript(
      makeSlurmTarget({ default_output_dir: "/vol/bitbucket/ys25/bad-runs" }),
      "https://alchemy-v2.yuzhes.com",
      "secret-token",
      { default_output_dir: "/vol/gpudata/ys25-MySpace/alchemy-runs" },
    );

    expect(script).toContain("  --default-output-dir \"/vol/gpudata/ys25-MySpace/alchemy-runs\"");
    expect(script).not.toContain("/vol/bitbucket/ys25/bad-runs");
  });
});
