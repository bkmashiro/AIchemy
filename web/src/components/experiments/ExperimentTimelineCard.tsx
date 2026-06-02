import { useState } from "react";
import { Link } from "react-router-dom";
import { ExperimentEvent, experimentsApi } from "../../lib/api";
import { formatRelTime } from "../../lib/format";
import { EVENT_BADGE, formatEventData, artifactLocator } from "./experimentDetailUtils";

export function ExperimentTimelineCard({
  experimentId,
  events,
  onNoteAdded,
}: {
  experimentId: string;
  events: ExperimentEvent[];
  onNoteAdded: () => void;
}) {
  const [message, setMessage] = useState("");
  const [taskId, setTaskId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const sorted = [...events].sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  );

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-gray-400">Timeline</h2>
        <span className="text-xs text-gray-600">
          {sorted.length} event{sorted.length === 1 ? "" : "s"}
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

      {sorted.length === 0 ? (
        <p className="text-xs text-gray-600 text-center py-6">
          No timeline events yet
        </p>
      ) : (
        <ul className="space-y-2">
          {sorted.map((ev) => {
            const badge =
              EVENT_BADGE[ev.kind] || "bg-gray-800 text-gray-400 border-gray-700";
            const isArtifactKind = ev.kind === "artifact" || ev.kind === "checkpoint";
            const artifact = isArtifactKind ? artifactLocator(ev.data) : null;
            const dataStr = !artifact ? formatEventData(ev.data) : null;
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
                  <span className="text-gray-300">{ev.message}</span>
                  <span className="text-gray-600 ml-auto">
                    {formatRelTime(ev.created_at)}
                  </span>
                </div>
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
                    {artifact.type && (
                      <span className="px-1 py-0.5 rounded border text-[10px] bg-gray-800 text-gray-400 border-gray-700">
                        {artifact.type}
                      </span>
                    )}
                    {artifact.name && <span className="text-gray-400">{artifact.name}</span>}
                    {typeof artifact.step === "number" && (
                      <span className="text-gray-500">step {artifact.step}</span>
                    )}
                    <code className="font-mono text-gray-300 break-all">{artifact.locator}</code>
                  </div>
                )}
                {dataStr && (
                  <pre className="mt-1 text-[10px] text-gray-600 bg-gray-950/40 rounded px-2 py-1 overflow-x-auto font-mono">
                    {dataStr}
                  </pre>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
