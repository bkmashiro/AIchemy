import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import type {
  ExperimentDetail,
  ExperimentEvent,
  ExperimentRecommendation,
  ExperimentSummaryResponse,
} from "../../../lib/api";
import { experimentsApi } from "../../../lib/api";
import { ExperimentResearchCallCard } from "../ExperimentResearchCallCard";

vi.mock("../../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/api")>();
  return {
    ...actual,
    experimentsApi: {
      ...actual.experimentsApi,
      getResearchBundle: vi.fn(),
      addNote: vi.fn(),
      addEvent: vi.fn(),
      decide: vi.fn(),
    },
  };
});

function makeExperiment(
  overrides: Partial<ExperimentDetail> = {},
): ExperimentDetail {
  return {
    id: "exp-a",
    name: "research-call",
    criteria: {},
    grid_id: "grid-a",
    status: "running",
    results: {},
    created_at: "2026-06-01T00:00:00.000Z",
    description: "",
    ...overrides,
  };
}

function makeSummary(
  overrides: Partial<ExperimentSummaryResponse> = {},
): ExperimentSummaryResponse {
  return {
    id: "exp-a",
    name: "research-call",
    status: "running",
    family: null,
    hypothesis: null,
    expected_outcome: null,
    fork_reason: null,
    goal_metric: null,
    goal_direction: null,
    decision: null,
    decision_reason: null,
    decision_at: null,
    created_at: "2026-06-01T00:00:00.000Z",
    parent: null,
    children: [],
    task_counts: {},
    validation: { passed: 2, failed: 1, total: 3 },
    best_metrics: { loss: 0.1234 },
    primary_metric: null,
    recommendation: null,
    timeline_event_count: 0,
    config: null,
    config_diff: null,
    ...overrides,
  };
}

function installDownloadSpy() {
  let blobValue: any = null;
  const originalCreateObjectURL = (URL as any).createObjectURL;
  const originalRevokeObjectURL = (URL as any).revokeObjectURL;
  const originalBlob = (globalThis as any).Blob;
  const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

  (globalThis as any).Blob = class {
    chunks: any[];

    constructor(chunks: any[]) {
      this.chunks = chunks;
    }

    text() {
      return Promise.resolve(this.chunks.join(""));
    }
  } as any;

  (URL as any).createObjectURL = (value: any) => {
    blobValue = value;
    return "blob:mock";
  };
  (URL as any).revokeObjectURL = () => undefined;

  return {
    getBlobText: async () => {
      return blobValue ? blobValue.text() : "";
    },
    restore: () => {
      (URL as any).createObjectURL = originalCreateObjectURL;
      (URL as any).revokeObjectURL = originalRevokeObjectURL;
      (globalThis as any).Blob = originalBlob;
      clickSpy.mockRestore();
    },
  };
}

function makeResearchBundle() {
  return {
    experiment: {
      id: "exp-a",
      name: "research-call",
      status: "running",
      family: "research",
    },
    summary: {
      recommendation: {
        action: "rerun",
        verdict: "rerun",
        reason: "Signal remains noisy and sample count is limited.",
        metric: "val_loss",
        value: 0.9012,
        baseline_value: 0.9123,
        delta: -0.0111,
        direction: "down",
      },
      decision: "rerun",
      decision_reason: "Need stronger confidence before shipping",
      best_metrics: { val_loss: 0.9012 },
      timeline_event_count: 2,
    },
    decision: {
      decision: "rerun",
      reason: "Need stronger confidence before shipping",
      decided_at: "2026-06-02T00:00:00.000Z",
    },
    timeline: {
      events: [
        {
          kind: "artifact",
          created_at: "2026-06-01T00:00:00.000Z",
          message: "artifact emitted",
        },
        {
          kind: "checkpoint",
          created_at: "2026-06-01T01:00:00.000Z",
          message: "checkpoint saved",
        },
      ],
    },
    manifest: { enabled: false },
    generated_at: "2026-06-01T00:00:00.000Z",
  };
}

function makeRecentEvent(
  id: string,
  kind: ExperimentEvent["kind"],
  overrides: Partial<ExperimentEvent> = {},
): ExperimentEvent {
  return {
    id,
    experiment_id: "exp-a",
    kind,
    message: `${kind} note`,
    created_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function copyToSection(name: string) {
  const heading = screen.getByText(name);
  const container = heading.parentElement?.parentElement ?? heading.closest("div");
  if (!container) {
    throw new Error(`Unable to find section ${name}`);
  }
  return container;
}

function makeRecommendation(
  overrides: Partial<ExperimentRecommendation> = {},
): ExperimentRecommendation {
  return {
    action: "Rerun with larger cohort",
    verdict: "rerun",
    reason: "Signal is still noisy and sample count is low.",
    metric: "val_loss",
    value: 0.9012,
    baseline_value: 0.9123,
    delta: -0.0111,
    direction: "down",
    evidence_quality: "weak",
    evidence_reason: "Signal is still noisy and sample count is low.",
    sample_count: 1,
    baseline_source: "parent",
    comparable_count: 1,
    ...overrides,
  };
}

describe("ExperimentResearchCallCard", () => {
  beforeEach(() => {
    vi.mocked(experimentsApi.getResearchBundle).mockReset();
    vi.mocked(experimentsApi.addNote).mockReset();
    vi.mocked(experimentsApi.addEvent).mockReset();
    vi.mocked(experimentsApi.decide).mockReset();
  });

  it("submits a note via research writeback", async () => {
    vi.mocked(experimentsApi.addNote).mockResolvedValue({
      id: "note-1",
      experiment_id: "exp-a",
      kind: "note",
      message: "Need stronger prior",
      created_at: "2026-06-01T00:00:00.000Z",
      data: {},
    });
    const onChanged = vi.fn();

    render(<ExperimentResearchCallCard exp={makeExperiment()} summary={makeSummary()} onChanged={onChanged} />);

    const writebackSection = copyToSection("Research writeback");
    const noteInput = within(writebackSection).getByPlaceholderText("Write a research note");

    expect(within(writebackSection).getByRole("button", { name: "Submit writeback" })).toBeDisabled();
    fireEvent.change(noteInput, { target: { value: "Need stronger prior" } });
    fireEvent.click(within(writebackSection).getByRole("button", { name: "Submit writeback" }));

    await waitFor(() => {
      expect(experimentsApi.addNote).toHaveBeenCalledWith("exp-a", "Need stronger prior");
      expect(screen.getByText("Writeback saved.")).toBeInTheDocument();
    });

    expect(onChanged).toHaveBeenCalledWith("exp-a");
    expect(noteInput).toHaveValue("");
  });

  it("submits a decision via research writeback", async () => {
    vi.mocked(experimentsApi.decide).mockResolvedValue(makeExperiment({ decision: "rerun" }));

    render(<ExperimentResearchCallCard exp={makeExperiment()} summary={makeSummary()} />);

    const writebackSection = copyToSection("Research writeback");
    fireEvent.click(within(writebackSection).getByRole("button", { name: "Record decision" }));
    expect(within(writebackSection).getByRole("button", { name: "Submit writeback" })).toBeDisabled();

    fireEvent.change(within(writebackSection).getByRole("combobox", { name: "Decision" }), {
      target: { value: "rerun" },
    });
    fireEvent.change(within(writebackSection).getByPlaceholderText("Write decision reason"), {
      target: { value: "Need stronger evidence from second run" },
    });

    fireEvent.click(within(writebackSection).getByRole("button", { name: "Submit writeback" }));

    await waitFor(() => {
      expect(experimentsApi.decide).toHaveBeenCalledWith(
        "exp-a",
        "rerun",
        "Need stronger evidence from second run",
      );
    });

    expect(screen.getByText("Needs stronger evidence")).toBeInTheDocument();
    expect(screen.getByText("Writeback saved.")).toBeInTheDocument();
  });

  it("renders recent writebacks from note/decision/artifact/checkpoint events", () => {
    const recentEvents: ExperimentEvent[] = [
      makeRecentEvent("evt-1", "note", {
        created_at: "2026-06-01T09:00:00.000Z",
        message: "first note",
      }),
      makeRecentEvent("evt-2", "created", {
        created_at: "2026-06-01T09:30:00.000Z",
        message: "not relevant",
      }),
      makeRecentEvent("evt-3", "artifact", {
        created_at: "2026-06-01T12:00:00.000Z",
        message: "artifact recorded",
        data: { locator: "s3://artifacts/run-a" },
      }),
      makeRecentEvent("evt-4", "checkpoint", {
        created_at: "2026-06-01T11:00:00.000Z",
        message: "checkpoint recorded",
        data: { locator: "s3://checkpoints/run-a" },
      }),
      makeRecentEvent("evt-6", "note", {
        created_at: "2026-06-01T13:00:00.000Z",
        message: "new note",
      }),
    ];

    render(
      <ExperimentResearchCallCard
        exp={makeExperiment()}
        summary={makeSummary()}
        recentEvents={recentEvents}
      />,
    );

    const writebacks = copyToSection("Recent writebacks");
    const rows = within(writebacks).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(within(writebacks).getByText("artifact recorded")).toBeInTheDocument();
    expect(within(writebacks).getByText("checkpoint recorded")).toBeInTheDocument();
    expect(within(writebacks).getByText("new note")).toBeInTheDocument();
    expect(screen.queryByText("first note")).not.toBeInTheDocument();
    expect(screen.queryByText("not relevant")).not.toBeInTheDocument();

    const artifactLocator = within(writebacks).getByText("s3://artifacts/run-a");
    expect(artifactLocator.closest("code")).not.toBeNull();
    const checkpointLocator = within(writebacks).getByText("s3://checkpoints/run-a");
    expect(checkpointLocator.closest("code")).not.toBeNull();
  });


  it("renders recent decision rerun as needs stronger evidence in recent writebacks", () => {
    const recentEvents: ExperimentEvent[] = [
      makeRecentEvent("evt-rerun", "decision", {
        created_at: "2026-06-01T10:00:00.000Z",
        message: "rerun",
        data: { decision: "rerun", reason: "Need stronger evidence." },
      }),
    ];

    render(
      <ExperimentResearchCallCard
        exp={makeExperiment()}
        summary={makeSummary()}
        recentEvents={recentEvents}
      />,
    );

    const writebacks = copyToSection("Recent writebacks");
    expect(within(writebacks).getAllByText(/needs stronger evidence/i).length).toBeGreaterThan(0);
    expect(within(writebacks).queryByText(/\brerun\b/i)).not.toBeInTheDocument();
  });

  it.each([
    ["artifact", "Attach artifact"],
    ["checkpoint", "Attach checkpoint"],
  ])("submits %s locator via research writeback", async (kind, modeLabel) => {
    vi.mocked(experimentsApi.addEvent).mockResolvedValue({
      id: `${kind}-1`,
      experiment_id: "exp-a",
      kind: kind as "artifact" | "checkpoint",
      message: `${kind}: locator://example/path`,
      created_at: "2026-06-01T00:00:00.000Z",
      data: {},
    });

    render(<ExperimentResearchCallCard exp={makeExperiment()} summary={makeSummary()} />);

    const writebackSection = copyToSection("Research writeback");
    fireEvent.click(within(writebackSection).getByRole("button", { name: modeLabel }));
    const locatorInput = within(writebackSection).getByPlaceholderText("Write locator");
    const locator = `locator://${kind}/example/path`;

    expect(within(writebackSection).getByRole("button", { name: "Submit writeback" })).toBeDisabled();
    fireEvent.change(locatorInput, { target: { value: locator } });
    fireEvent.click(within(writebackSection).getByRole("button", { name: "Submit writeback" }));

    await waitFor(() => {
      expect(experimentsApi.addEvent).toHaveBeenCalledWith("exp-a", {
        kind: kind as "artifact" | "checkpoint",
        message: expect.stringContaining(locator),
        data: expect.objectContaining({ locator, type: kind }),
      });
    });

    expect(screen.getByText("Writeback saved.")).toBeInTheDocument();
  });

  it("refreshes parent state through callback after successful writeback", async () => {
    vi.mocked(experimentsApi.addNote).mockResolvedValue({
      id: "note-2",
      experiment_id: "exp-a",
      kind: "note",
      message: "callback test",
      created_at: "2026-06-01T00:00:00.000Z",
      data: {},
    });

    const onChanged = vi.fn();
    render(<ExperimentResearchCallCard exp={makeExperiment()} summary={makeSummary()} onChanged={onChanged} />);

    const writebackSection = copyToSection("Research writeback");
    const noteInput = within(writebackSection).getByPlaceholderText("Write a research note");
    fireEvent.change(noteInput, { target: { value: "callback test" } });
    fireEvent.click(within(writebackSection).getByRole("button", { name: "Submit writeback" }));

    await waitFor(() => {
      expect(onChanged).toHaveBeenCalledWith("exp-a");
    });
  });

  it("uses explicit decision action when present even if recommendation exists", () => {
    const exp = makeExperiment({ decision: "drop" });
    const summary = makeSummary({
      decision: "drop",
      recommendation: makeRecommendation({ action: "Rerun with larger cohort" }),
    });

    render(<ExperimentResearchCallCard exp={exp} summary={summary} />);

    expect(screen.getByText("Fold into background")).toBeInTheDocument();
    expect(screen.getByText("Plan replication with larger cohort")).toBeInTheDocument();
  });

  it("uses user-facing copy for rerun decisions", () => {
    const exp = makeExperiment({ decision: "rerun" });
    const summary = makeSummary({
      decision: "rerun",
    });

    render(<ExperimentResearchCallCard exp={exp} summary={summary} />);

    expect(screen.getByText("Plan replication")).toBeInTheDocument();
    expect(screen.getByText("needs stronger evidence")).toBeInTheDocument();
  });

  it("falls back to summary recommendation when no explicit decision exists", () => {
    const exp = makeExperiment({ fork_reason: "from null" });
    const summary = makeSummary({
      recommendation: makeRecommendation({ action: "Rerun with larger cohort" }),
    });

    render(<ExperimentResearchCallCard exp={exp} summary={summary} />);

    expect(screen.getAllByText("Signal is still noisy and sample count is low.")).toHaveLength(2);
    expect(screen.getByText("val_loss")).toBeInTheDocument();
    expect(screen.getByText(/\b0\.9012\b/)).toBeInTheDocument();
    expect(screen.getByText(/\b0\.9123\b/)).toBeInTheDocument();
    expect(screen.getByText(/-0\.0111/)).toBeInTheDocument();
    expect(screen.getByText("weak")).toBeInTheDocument();
    expect(screen.getByText(/baseline: parent/)).toBeInTheDocument();
    expect(screen.getByText(/Samples: 1/)).toBeInTheDocument();
    expect(screen.getByText(/Comparables: 1/)).toBeInTheDocument();
  });

  it("renders recommendation action rerun as needs stronger evidence", () => {
    const exp = makeExperiment({});
    const summary = makeSummary({
      recommendation: makeRecommendation({
        action: "rerun",
        verdict: null,
        reason: "Noisy signal.",
      }),
    });

    render(<ExperimentResearchCallCard exp={exp} summary={summary} />);

    const labels = screen.getAllByText("Needs stronger evidence");
    expect(labels).toHaveLength(2);
  });

  it("renders a dry-run replication plan preview for rerun recommendations", () => {
    const exp = makeExperiment({});
    const summary = makeSummary({
      recommendation: makeRecommendation({
        action: "rerun",
        verdict: null,
        reason: "Need higher confidence before shipping",
      }),
    });

    render(<ExperimentResearchCallCard exp={exp} summary={summary} />);

    expect(screen.getByText("Replication plan")).toBeInTheDocument();
    expect(screen.getByText(/Replication plan preview for stronger evidence/)).toBeInTheDocument();
    expect(
      screen.getByText("alch experiments replication-plan research-call --reason 'Need higher confidence before shipping'"),
    ).toBeInTheDocument();
    expect(screen.getByText((content) => /Explicit submit required\./.test(content))).toBeInTheDocument();
    const replicationSection = copyToSection("Replication plan");
    expect(
      within(replicationSection).getByRole("button", {
        name: /copy replication plan cli/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Download plan JSON/i })).toBeInTheDocument();
    expect(screen.getByText((content) => content.includes("client.replication_plan(\"research-call\""))).toBeInTheDocument();
  });

  it("copies replication-plan CLI hint to clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    const exp = makeExperiment({});
    const summary = makeSummary({
      recommendation: makeRecommendation({
        action: "rerun",
        verdict: null,
        reason: "Need higher confidence before shipping",
      }),
    });

    render(<ExperimentResearchCallCard exp={exp} summary={summary} />);

    const replicationSection = copyToSection("Replication plan");
    fireEvent.click(
      within(replicationSection).getByRole("button", {
        name: /copy replication plan cli/i,
      }),
    );

    expect(writeText).toHaveBeenCalledWith(
      "alch experiments replication-plan research-call --reason 'Need higher confidence before shipping'",
    );
    expect(await screen.findByText((content) => content.includes("CLI copied to clipboard."))).toBeInTheDocument();
  });

  it("shows an error if copying CLI hint fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    const exp = makeExperiment({});
    const summary = makeSummary({
      recommendation: makeRecommendation({
        action: "rerun",
        verdict: null,
        reason: "Need higher confidence before shipping",
      }),
    });

    render(<ExperimentResearchCallCard exp={exp} summary={summary} />);

    const replicationSection = copyToSection("Replication plan");
    fireEvent.click(
      within(replicationSection).getByRole("button", {
        name: /copy replication plan cli/i,
      }),
    );

    expect(await screen.findByText("denied")).toBeInTheDocument();
  });

  it("downloads research bundle markdown with recommendation and timeline details", async () => {
    const bundle = makeResearchBundle();
    vi.mocked(experimentsApi.getResearchBundle).mockResolvedValue(bundle as any);
    const spy = installDownloadSpy();

    const exp = makeExperiment({});
    const summary = makeSummary({
      recommendation: makeRecommendation({
        action: "rerun",
        verdict: null,
        reason: "Need stronger confidence before shipping",
      }),
    });

    render(<ExperimentResearchCallCard exp={exp} summary={summary} />);

    fireEvent.click(screen.getByRole("button", { name: /Export Markdown/i }));
    await waitFor(async () => {
      const markdown = await spy.getBlobText();
      expect(markdown).toContain("# Research bundle: research-call (exp-a)");
      expect(markdown).toContain("- action: Needs stronger evidence");
      expect(markdown).toContain("- verdict: Needs stronger evidence");
      expect(markdown).toContain("- reason: Signal remains noisy and sample count is limited.");
      expect(markdown).toContain("## Decision");
      expect(markdown).toContain("- decision: needs stronger evidence");
      expect(markdown).toContain("- reason: Need stronger confidence before shipping");
      expect(markdown).toContain("Recent timeline events");
      expect(markdown).toContain("artifact emitted");
      expect(markdown).toContain("checkpoint saved");
      expect(markdown).toContain("alch experiments replication-plan research-call --reason 'Need stronger confidence before shipping'");
      spy.restore();
    });
  });

  it("copies the research bundle CLI command to clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    const exp = makeExperiment({});
    const summary = makeSummary({
      recommendation: makeRecommendation({
        action: "keep",
        verdict: null,
        reason: "Looks solid",
      }),
    });

    render(<ExperimentResearchCallCard exp={exp} summary={summary} />);

    const bundleSection = copyToSection("Research bundle");
    fireEvent.click(
      within(bundleSection).getByRole("button", {
        name: /copy bundle cli/i,
      }),
    );

    expect(writeText).toHaveBeenCalledWith("alch experiments bundle research-call");
    expect(await screen.findByText((content) => content.includes("Bundle CLI copied to clipboard."))).toBeInTheDocument();
  });

  it("downloads the existing research bundle JSON export", async () => {
    const bundle = makeResearchBundle();
    vi.mocked(experimentsApi.getResearchBundle).mockResolvedValue(bundle as any);
    const spy = installDownloadSpy();

    const exp = makeExperiment({});
    const summary = makeSummary({
      recommendation: makeRecommendation({
        action: "keep",
        verdict: null,
      }),
    });

    render(<ExperimentResearchCallCard exp={exp} summary={summary} />);

    fireEvent.click(screen.getByRole("button", { name: /Export JSON/i }));
    await waitFor(async () => {
      const raw = await spy.getBlobText();
      const payload = JSON.parse(raw);

      expect(payload.experiment.id).toBe("exp-a");
      expect(payload.summary).toEqual(bundle.summary);
      expect(payload.timeline.events).toHaveLength(2);

      spy.restore();
    });
  });

  it("downloads a replication-plan manifest JSON with explicit safeguards", async () => {
    const exp = makeExperiment({
      parent_id: "parent-exp",
      parent_name: "Parent Experiment",
      family: "research",
      goal_metric: "val_loss",
      goal_direction: "min",
    });
    const summary = makeSummary({
      goal_metric: "val_loss",
      goal_direction: "min",
      parent: {
        id: "parent-exp",
        name: "Parent Experiment",
        status: "running",
        family: "research",
        parent_id: null,
        decision: null,
        fork_reason: null,
        goal_metric: null,
        goal_direction: null,
        created_at: "2026-06-01T00:00:00.000Z",
      },
      recommendation: makeRecommendation({
        action: "rerun",
        verdict: null,
        reason: "Need higher confidence before shipping",
      }),
    });

    let manifestBlob: any = null;
    const originalCreateObjectURL = (URL as any).createObjectURL;
    const originalRevokeObjectURL = (URL as any).revokeObjectURL;
    const OriginalBlob = (globalThis as any).Blob;
    const anchorClickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    (globalThis as any).Blob = class {
      chunks: any[];

      constructor(chunks: any[]) {
        this.chunks = chunks;
      }

      text() {
        return Promise.resolve(this.chunks.join(""));
      }
    };
    (URL as any).createObjectURL = (value: any) => {
      manifestBlob = value;
      return "blob:mock-manifest";
    };
    (URL as any).revokeObjectURL = () => undefined;

    render(<ExperimentResearchCallCard exp={exp} summary={summary} />);

    fireEvent.click(screen.getByRole("button", { name: /Download plan JSON/i }));

    const payloadText = manifestBlob ? await manifestBlob.text() : "{}";
    const payload = JSON.parse(payloadText);

    expect(payload.kind).toBe("replication-plan");
    expect(payload.dry_run).toBe(true);
    expect(payload.experiment).toMatchObject({
      id: "exp-a",
      name: "research-call",
    });
    expect(payload.parent).toMatchObject({
      id: "parent-exp",
      name: "Parent Experiment",
      family: "research",
    });
    expect(payload.goal_metric).toBe("val_loss");
    expect(payload.goal_direction).toBe("min");
    expect(payload.recommendation).toMatchObject({
      action: "Needs stronger evidence",
      verdict: null,
      reason: "Need higher confidence before shipping",
      metric: "val_loss",
      value: 0.9012,
      baseline: 0.9123,
      delta: -0.0111,
      evidence: "weak",
    });
    expect(payload.cli).toContain("--reason");
    expect(payload.safeguards).toContain("This manifest is dry_run=true and does not submit any task by itself.");
    expect(payload.safeguards).toContain("Explicit submit is required before running replication");

    (URL as any).createObjectURL = originalCreateObjectURL;
    (URL as any).revokeObjectURL = originalRevokeObjectURL;
    (globalThis as any).Blob = OriginalBlob;
    anchorClickSpy.mockRestore();
  });

  it("shell-quotes replication plan reasons with embedded single quotes", () => {
    const exp = makeExperiment({});
    const summary = makeSummary({
      recommendation: makeRecommendation({
        action: "rerun",
        verdict: null,
        reason: "Need 'higher' confidence",
      }),
    });

    render(<ExperimentResearchCallCard exp={exp} summary={summary} />);

    expect(
      screen.getByText("alch experiments replication-plan research-call --reason 'Need '\\''higher'\\'' confidence'"),
    ).toBeInTheDocument();
  });

  it.each(["keep", "drop", "fork"])(
    "does not render a replication plan for recommendation %s",
    (recAction) => {
      const exp = makeExperiment({});
      const summary = makeSummary({
        recommendation: makeRecommendation({
          action: recAction,
          verdict: null,
          reason: "Steady signal.",
        }),
      });

      render(<ExperimentResearchCallCard exp={exp} summary={summary} />);

      expect(screen.queryByText("Replication plan")).not.toBeInTheDocument();
    },
  );

  it("renders recommendation card defensively when partially missing fields", () => {
    const exp = makeExperiment();
    const summary = makeSummary({
      recommendation: makeRecommendation({
        action: null,
        verdict: null,
        reason: null,
        metric: null,
        value: null,
        baseline_value: null,
        delta: null,
        direction: null,
      }),
    });

    render(<ExperimentResearchCallCard exp={exp} summary={summary} />);

    expect(screen.getByText("No action")).toBeInTheDocument();
    expect(screen.getByText("No verdict")).toBeInTheDocument();
  });
});
