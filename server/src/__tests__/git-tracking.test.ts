import { describe, expect, it } from "vitest";
import { buildReadManifestCommand, shellQuote } from "../git-tracking";

describe("git tracking command construction", () => {
  it("shell-quotes manifest read paths", () => {
    expect(shellQuote("")).toBe("''");
    expect(shellQuote("/repo with spaces")).toBe("'/repo with spaces'");
    expect(shellQuote("name'with'quotes")).toBe("'name'\\''with'\\''quotes'");
  });

  it("builds read-manifest command without exposing metacharacters outside quoted args", () => {
    const command = buildReadManifestCommand("/repo; touch /tmp/pwned", "exp $(touch bad) ' q");
    expect(command).toBe("cd '/repo; touch /tmp/pwned' && cat 'experiments/exp $(touch bad) '\\'' q.yaml'");
  });
});
