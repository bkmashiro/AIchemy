import { useEffect, useRef, useState, useCallback } from "react";
import { tasksApi } from "../lib/api";

interface Props {
  taskId: string;
  /** Initial lines from task.log_buffer; more arrive via WebSocket */
  initialLines?: string[];
  /** Live lines from WebSocket (passed from parent if available) */
  liveLines?: string[];
  maxHeight?: string;
}

function colorize(line: string): string {
  if (/error|exception|traceback|critical/i.test(line)) return "text-red-400";
  if (/warn(ing)?/i.test(line)) return "text-yellow-400";
  if (/success|completed|done|finished/i.test(line)) return "text-green-400";
  if (/step|epoch|iter/i.test(line)) return "text-blue-300";
  return "text-gray-300";
}

export default function LogViewer({ taskId, initialLines = [], liveLines = [], maxHeight = "300px" }: Props) {
  const [fetchedLines, setFetchedLines] = useState<string[]>(initialLines);
  const [filter, setFilter] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // Fetch history from REST on mount
  useEffect(() => {
    tasksApi
      .logs(taskId, 500)
      .then((data) => setFetchedLines(data.lines))
      .catch(() => {});
  }, [taskId]);

  // Merge fetched (REST snapshot) + live lines
  // Use fetched as ground truth, then append any live lines beyond the snapshot length
  const allLines = (() => {
    if (liveLines.length <= fetchedLines.length) return fetchedLines;
    // Live buffer has lines beyond the snapshot — append the newer ones
    return [...fetchedLines, ...liveLines.slice(fetchedLines.length)];
  })();

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [allLines, autoScroll]);

  const handleScroll = () => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 40);
  };

  const filteredLines = filter
    ? allLines.filter((l) => l.toLowerCase().includes(filter.toLowerCase()))
    : allLines;

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(filteredLines.join("\n")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [filteredLines]);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search logs..."
          className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-blue-500 placeholder-gray-600"
        />
        <span className="text-xs text-gray-600 shrink-0">
          {filteredLines.length}/{allLines.length}
        </span>
        <button
          onClick={handleCopy}
          className="text-xs px-2 py-1 rounded border border-gray-700 text-gray-500 hover:text-gray-300 transition-colors shrink-0"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
        <button
          onClick={() => setAutoScroll((v) => !v)}
          className={`text-xs px-2 py-1 rounded border transition-colors shrink-0 ${
            autoScroll
              ? "bg-green-900/30 border-green-800/50 text-green-400"
              : "border-gray-700 text-gray-600 hover:text-gray-400"
          }`}
        >
          Auto
        </button>
      </div>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="bg-gray-950 rounded-lg p-3 font-mono text-xs overflow-y-auto border border-gray-800"
        style={{ maxHeight }}
      >
        {filteredLines.length === 0 ? (
          <span className="text-gray-700">
            {allLines.length === 0 ? "No output yet..." : "No matching lines"}
          </span>
        ) : (
          filteredLines.map((line, i) => (
            <div key={i} className={`leading-5 whitespace-pre-wrap break-all ${colorize(line)}`}>
              {line}
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}
