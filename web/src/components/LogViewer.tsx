import { useEffect, useRef, useState } from "react";

interface Props {
  lines: string[];
  maxHeight?: string;
}

export default function LogViewer({ lines, maxHeight = "300px" }: Props) {
  const endRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (autoScroll) {
      endRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [lines, autoScroll]);

  const handleScroll = () => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 40;
    setAutoScroll(atBottom);
  };

  const filteredLines = filter
    ? lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase()))
    : lines;

  const colorize = (line: string) => {
    if (/error|exception|traceback|failed|critical/i.test(line)) return "text-red-400";
    if (/warn(ing)?/i.test(line)) return "text-yellow-400";
    if (/success|completed|done|finished/i.test(line)) return "text-green-400";
    if (/step|epoch|iter/i.test(line)) return "text-blue-300";
    return "text-green-400";
  };

  return (
    <div className="flex flex-col gap-1" style={{ height: maxHeight === "100%" ? "100%" : undefined }}>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter logs..."
          className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-blue-500 placeholder-gray-600"
        />
        <span className="text-xs text-gray-600">{filteredLines.length}/{lines.length}</span>
        <button
          onClick={() => setAutoScroll((v) => !v)}
          className={`text-xs px-2 py-1 rounded border transition-colors ${
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
        className="bg-gray-950 rounded-lg p-3 font-mono text-xs overflow-y-auto border border-gray-800 flex-1"
        style={{ maxHeight: maxHeight !== "100%" ? maxHeight : undefined }}
      >
        {filteredLines.length === 0 ? (
          <span className="text-gray-700">{lines.length === 0 ? "No output yet..." : "No matching lines"}</span>
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
