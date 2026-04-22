import { useState, useRef, useEffect } from "react";
import { stubsApi } from "../lib/api";

interface Props {
  stubId: string;
}

interface ShellEntry {
  command: string;
  stdout: string;
  stderr: string;
  exit_code: number;
  timed_out: boolean;
}

export default function RemoteShell({ stubId }: Props) {
  const [history, setHistory] = useState<ShellEntry[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cmd = input.trim();
    if (!cmd || loading) return;
    setInput("");
    setLoading(true);
    try {
      const result = await stubsApi.shell(stubId, cmd);
      setHistory((prev) => [...prev, { command: cmd, ...result }]);
    } catch (err: any) {
      setHistory((prev) => [
        ...prev,
        { command: cmd, stdout: "", stderr: err.message || "Request failed", exit_code: -1, timed_out: false },
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-black rounded-xl border border-gray-800 font-mono text-xs">
      <div className="px-3 py-2 border-b border-gray-800 text-gray-400 text-xs">
        Remote Shell — {stubId.slice(0, 8)}...
      </div>
      <div className="p-3 space-y-3 max-h-80 overflow-y-auto">
        {history.map((entry, i) => (
          <div key={i}>
            <div className="text-blue-400">$ {entry.command}</div>
            {entry.stdout && (
              <pre className="text-green-400 whitespace-pre-wrap break-all">{entry.stdout}</pre>
            )}
            {entry.stderr && (
              <pre className="text-red-400 whitespace-pre-wrap break-all">{entry.stderr}</pre>
            )}
            {entry.timed_out && <div className="text-yellow-400">Timed out</div>}
            {entry.exit_code !== 0 && !entry.timed_out && (
              <div className="text-gray-500">exit code: {entry.exit_code}</div>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <form onSubmit={handleSubmit} className="border-t border-gray-800 flex items-center px-3 py-2 gap-2">
        <span className="text-blue-400">$</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={loading}
          placeholder="Enter command..."
          className="flex-1 bg-transparent text-green-400 outline-none placeholder-gray-700"
        />
        {loading && <span className="text-gray-500 text-xs">running...</span>}
      </form>
    </div>
  );
}
