import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ExperimentEvent, experimentsApi } from "../../lib/api";
import { formatRelTime } from "../../lib/format";
import {
  EVENT_BADGE,
  formatEventData,
  artifactLocator,
  decisionLabelForFilter,
} from "./experimentDetailUtils";

type TimelineFilter = "all" | "notes" | "decisions" | "artifacts" | "checkpoints" | "tasks";
type TimelineOrder = "newest" | "oldest";

const TASK_EVENT_KINDS = new Set(["task_started", "task_completed", "task_failed"]);
const FILTER_ORDER: TimelineFilter[] = [
  "all",
  "notes",
  "decisions",
  "artifacts",
  "checkpoints",
  "tasks",
];

const FILTER_LABEL: Record<TimelineFilter, string> = {
  all: "all",
  notes: "notes",
  decisions: "decisions",
  artifacts: "artifacts",
  checkpoints: "checkpoints",
  tasks: "tasks",
};

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isDecisionLikeMessage(value: unknown): string | null {
  const normalized = normalizeText(value)?.toLowerCase();
  if (!normalized) return null;
  const knownDecisionLike = [
    "keep",
    "try_more",
    "try more",
    "discard",
    "drop",
    "fork",
    "rerun",
    "needs stronger evidence",
  ];
  if (!knownDecisionLike.includes(normalized)) return null;
  return normalized;
}

function formatDecisionLabel(raw: string): string {
  const normalized = decisionLabelForFilter(raw);
  if (!normalized) return raw;
  return normalized;
}

function getDecisionLabel(event: ExperimentEvent): string | null {
  if (event.kind !== "decision") return null;
  const fromData = normalizeText(event.data && event.data.decision);
  const fromMessage = fromData ? null : isDecisionLikeMessage(event.message);
  if (!fromData && !fromMessage) return null;
  const raw = fromData ?? fromMessage;
  if (!raw) return null;
  return formatDecisionLabel(raw);
}

function isHttpLocator(locator: string): boolean {
  return /^https?:\/\//i.test(locator);
}

function copyErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Could not copy locator.";
}

function matchesFilter(event: ExperimentEvent, filter: TimelineFilter): boolean {
  if (filter === "all") return true;
  if (filter === "notes") return event.kind === "note";
  if (filter === "decisions") return event.kind === "decision";
  if (filter === "artifacts") return event.kind === "artifact";
  if (filter === "checkpoints") return event.kind === "checkpoint";
  return TASK_EVENT_KINDS.has(event.kind);
}

export function ExperimentTimelineCard({
  experimentId,
  events,
  onNoteAdded,
  pageSize = 20,
}: {
  experimentId: string;
  events: ExperimentEvent[];
  onNoteAdded: () => void;
  pageSize?: number;
}) {
  const [message, setMessage] = useState("");
  const [taskId, setTaskId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<TimelineFilter>("all");
  const [timelineOrder, setTimelineOrder] = useState<TimelineOrder>("newest");
  const [currentPage, setCurrentPage] = useState(0);
  const [locatorCopyMessages, setLocatorCopyMessages] = useState<Record<string, string>>({});


  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!message.trim()) {
      setError("Message required");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await experimentsApi.addNote(experimentId, message.trim(), {
        task_id: taskId.trim() || undefined,
      });
      setMessage("");
      setTaskId("");
      onNoteAdded();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } };
      setError(e?.response?.data?.error ?? "Failed to add note");
    } finally {
      setSubmitting(false);
    }
  }

  async function copyLocator(eventId: string, locator: string) {
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
        throw new Error("Clipboard unavailable in this browser.");
      }
      await navigator.clipboard.writeText(locator);
      setLocatorCopyMessages((current) => ({
        ...current,
        [eventId]: "Locator copied to clipboard.",
      }));
    } catch (error: unknown) {
      setLocatorCopyMessages((current) => ({
        ...current,
        [eventId]: copyErrorMessage(error),
      }));
    }
  }

  const sorted = useMemo(
    () => [...events].sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [events],
  );

  const filterCounts: Record<TimelineFilter, number> = useMemo(
    () => ({
      all: sorted.length,
      notes: sorted.filter((ev) => ev.kind === "note").length,
      decisions: sorted.filter((ev) => ev.kind === "decision").length,
      artifacts: sorted.filter((ev) => ev.kind === "artifact").length,
      checkpoints: sorted.filter((ev) => ev.kind === "checkpoint").length,
      tasks: sorted.filter((ev) => TASK_EVENT_KINDS.has(ev.kind)).length,
    }),
    [sorted],
  );

  const filteredEvents = useMemo(
    () => {
      const list = sorted.filter((ev) => matchesFilter(ev, activeFilter));
      return timelineOrder === "oldest" ? [...list].reverse() : list;
    },
    [sorted, activeFilter, timelineOrder],
  );

  const safePageSize = Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(filteredEvents.length / safePageSize));

  useEffect(() => {
    setCurrentPage(0);
  }, [activeFilter]);

  useEffect(() => {
    setCurrentPage(0);
  }, [timelineOrder]);

  useEffect(() => {
    setCurrentPage((page) => Math.min(page, totalPages - 1));
  }, [totalPages]);

  const pageStart = currentPage * safePageSize;
  const pageEvents = filteredEvents.slice(pageStart, pageStart + safePageSize);
  const visibleStart = filteredEvents.length === 0 ? 0 : pageStart + 1;
  const visibleEnd = pageStart + pageEvents.length;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-md p-3">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-gray-400">Timeline</h2>
        <span className="text-xs text-gray-600">
          {filteredEvents.length === 0
            ? "0 events"
            : `${visibleStart}-${visibleEnd} of ${filteredEvents.length} event${filteredEvents.length === 1 ? "" : "s"}`}
        </span>
      </div>

      <form
        onSubmit={handleSubmit}
        className="mb-4 space-y-2 p-3 bg-gray-950/40 border border-gray-800 rounded-lg"
      >
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Add a note..."
          rows={2}
          className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600"
          disabled={submitting}
        />
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={taskId}
            onChange={(e) => setTaskId(e.target.value)}
            placeholder="Task ID (optional)"
            className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600 font-mono"
            disabled={submitting}
          />
          <button
            type="submit"
            disabled={submitting}
            className="px-3 py-1 text-xs rounded bg-blue-600/20 text-blue-400 border border-blue-700/40 hover:bg-blue-600/30 disabled:opacity-50"
          >
            {submitting ? "Posting..." : "Add note"}
          </button>
        </div>
        {error && <p className="text-red-400 text-xs">{error}</p>}
      </form>

      <div className="mb-3 flex flex-wrap gap-2 text-xs">
        {FILTER_ORDER.map((filter) => (
          <button
            type="button"
            key={filter}
            onClick={() => setActiveFilter(filter)}
            className={`px-2 py-1 rounded border transition-colors ${
              activeFilter === filter
                ? "bg-gray-700 text-gray-100 border-gray-600"
                : "text-gray-500 hover:text-gray-200 hover:bg-gray-800/50 border-gray-700"
            }`}
          >
            {filter === "all" ? "All" : filter[0].toUpperCase() + filter.slice(1)} ({filterCounts[filter]})
          </button>
        ))}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-gray-500">Chronology:</span>
        <button
          type="button"
          onClick={() => setTimelineOrder("newest")}
          aria-pressed={timelineOrder === "newest"}
          className={`px-2 py-1 rounded border transition-colors ${
            timelineOrder === "newest"
              ? "bg-gray-700 text-gray-100 border-gray-600"
              : "text-gray-500 hover:text-gray-200 hover:bg-gray-800/50 border-gray-700"
          }`}
        >
          Newest first
        </button>
        <button
          type="button"
          onClick={() => setTimelineOrder("oldest")}
          aria-pressed={timelineOrder === "oldest"}
          className={`px-2 py-1 rounded border transition-colors ${
            timelineOrder === "oldest"
              ? "bg-gray-700 text-gray-100 border-gray-600"
              : "text-gray-500 hover:text-gray-200 hover:bg-gray-800/50 border-gray-700"
          }`}
        >
          Oldest first
        </button>
        <span className="text-gray-500">
          Newest-first is the operational default; use oldest-first to reconstruct the full story.
        </span>
      </div>

      <p className="text-xs text-gray-600 mb-3">Showing {FILTER_LABEL[activeFilter]} evidence</p>

      {filteredEvents.length === 0 ? (
        <p className="text-xs text-gray-600 text-center py-6">
          {sorted.length === 0 ? "No timeline events yet" : "No matching timeline events"}
        </p>
      ) : (
        <>
          <ul className="space-y-2">
            {pageEvents.map((ev) => {
              const badge =
                EVENT_BADGE[ev.kind] || "bg-gray-800 text-gray-400 border-gray-700";
              const isArtifactKind = ev.kind === "artifact" || ev.kind === "checkpoint";
              const artifact = isArtifactKind ? artifactLocator(ev.data) : null;
              const decisionLabel = getDecisionLabel(ev);
              const rawDecisionReason = ev.kind === "decision" ? ev.data?.reason : undefined;
              const decisionReason = normalizeText(rawDecisionReason);
              const dataStr = !artifact ? formatEventData(ev.data) : null;
              const locatorCopyMessage = locatorCopyMessages[ev.id];
              return (
                <li
                  key={ev.id}
                  className="text-xs border-l-2 border-gray-800 pl-3 py-1"
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className={`px-1.5 py-0.5 rounded border text-[10px] ${badge}`}
                    >
                      {ev.kind}
                    </span>
                    <span className="text-gray-300">{decisionLabel ?? ev.message}</span>
                    <span className="text-gray-600 ml-auto">
                      {formatRelTime(ev.created_at)}
                    </span>
                  </div>
                  {decisionReason && <p className="mt-0.5 text-gray-500 text-[11px]">{decisionReason}</p>}
                  <div className="flex items-center gap-3 mt-0.5 text-gray-600 text-[11px]">
                    {ev.actor && <span>by {ev.actor}</span>}
                    {ev.task_id && (
                      <Link
                        to={`/tasks/${ev.task_id}`}
                        className="text-blue-500 hover:text-blue-400 font-mono"
                      >
                        task {ev.task_id.slice(0, 8)}
                      </Link>
                    )}
                  </div>
                  {artifact && (
                    <div className="mt-1 text-[11px] flex items-center gap-2 flex-wrap">
                      {artifact.name && <span className="text-gray-400">{artifact.name}</span>}
                      {artifact.type && (
                        <span className="px-1 py-0.5 rounded border text-[10px] bg-gray-800 text-gray-400 border-gray-700">
                          {artifact.type}
                        </span>
                      )}
                      {typeof artifact.step === "number" && (
                        <span className="text-gray-500">step {artifact.step}</span>
                      )}
                      <code className="font-mono text-gray-300 break-all">{artifact.locator}</code>
                      <button
                        type="button"
                        onClick={() => copyLocator(ev.id, artifact.locator)}
                        className="px-1.5 py-0.5 rounded border border-gray-700 text-gray-400 hover:text-gray-200 hover:bg-gray-800/40"
                      >
                        Copy locator
                      </button>
                      {isHttpLocator(artifact.locator) && (
                        <a
                          href={artifact.locator}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-500 hover:text-blue-400"
                        >
                          Open
                        </a>
                      )}
                    </div>
                  )}
                  {locatorCopyMessage && (
                    <p
                      className={`mt-1 text-[11px] ${
                        locatorCopyMessage === "Locator copied to clipboard." ? "text-green-400" : "text-red-400"
                      }`}
                    >
                      {locatorCopyMessage}
                    </p>
                  )}
                  {dataStr && (
                    <pre
                      data-timeline-event-data
                      className="mt-1 text-[10px] text-gray-500 bg-gray-950/40 rounded px-2 py-1 whitespace-pre-wrap break-words font-mono"
                    >
                      {dataStr}
                    </pre>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="mt-3 flex items-center justify-end gap-2 text-xs">
            <button
              type="button"
              onClick={() => setCurrentPage((page) => Math.max(0, page - 1))}
              disabled={currentPage === 0}
              className="px-2 py-1 rounded border border-gray-700 text-gray-400 hover:text-gray-200 disabled:opacity-40 disabled:hover:text-gray-400"
            >
              Previous
            </button>
            <span className="text-gray-600">
              Page {currentPage + 1} / {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setCurrentPage((page) => Math.min(totalPages - 1, page + 1))}
              disabled={currentPage >= totalPages - 1}
              className="px-2 py-1 rounded border border-gray-700 text-gray-400 hover:text-gray-200 disabled:opacity-40 disabled:hover:text-gray-400"
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}
