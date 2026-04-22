import { useEffect, useRef } from "react";

interface Props {
  lines: string[];
  maxHeight?: string;
}

export default function LogViewer({ lines, maxHeight = "300px" }: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  return (
    <div
      className="bg-black rounded-lg p-3 font-mono text-xs text-green-400 overflow-y-auto border border-gray-800"
      style={{ maxHeight }}
    >
      {lines.length === 0 ? (
        <span className="text-gray-600">No output yet...</span>
      ) : (
        lines.map((line, i) => (
          <div key={i} className="leading-5 whitespace-pre-wrap break-all">
            {line}
          </div>
        ))
      )}
      <div ref={endRef} />
    </div>
  );
}
