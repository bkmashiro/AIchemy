import { useState, useEffect, useRef, useCallback, KeyboardEvent } from "react";
import { Socket } from "socket.io-client";

interface HistoryEntry {
  command: string;
  output: string;
  exitCode: number | null;
  running: boolean;
}

interface Props {
  stubId: string;
  socket: Socket | null;
  isOnline: boolean;
}

export default function RemoteShell({ stubId, socket, isOnline }: Props) {
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [cmdHistory, setCmdHistory] = useState<string[]>([]);
  const [cmdHistoryIdx, setCmdHistoryIdx] = useState(-1);
  const [running, setRunning] = useState(false);
  const currentRequestIdRef = useRef<string | null>(null);

  const outputEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Scroll to bottom when history changes
  useEffect(() => {
    outputEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history]);

  const findLastRunningIdx = (arr: HistoryEntry[]): number => {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].running) return i;
    }
    return -1;
  };

  const appendChunk = useCallback((_requestId: string, chunk: string) => {
    setHistory((prev) => {
      const idx = findLastRunningIdx(prev);
      if (idx === -1) return prev;
      const entry = prev[idx];
      const updated = { ...entry, output: entry.output + chunk };
      return [...prev.slice(0, idx), updated, ...prev.slice(idx + 1)];
    });
  }, []);

  const finishEntry = useCallback((_requestId: string, exitCode: number) => {
    setHistory((prev) => {
      const idx = findLastRunningIdx(prev);
      if (idx === -1) return prev;
      const entry = prev[idx];
      const updated = { ...entry, running: false, exitCode };
      return [...prev.slice(0, idx), updated, ...prev.slice(idx + 1)];
    });
    setRunning(false);
    currentRequestIdRef.current = null;
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  useEffect(() => {
    if (!socket) return;

    const onRequestId = ({ request_id, stub_id }: { request_id: string; stub_id: string }) => {
      if (stub_id !== stubId) return;
      currentRequestIdRef.current = request_id;
    };

    const onOutput = (data: { request_id: string; chunk: string; stream: string }) => {
      appendChunk(data.request_id, data.chunk);
    };

    const onDone = (data: { request_id: string; exit_code: number }) => {
      finishEntry(data.request_id, data.exit_code);
    };

    socket.on("shell.request_id", onRequestId);
    socket.on("shell.output", onOutput);
    socket.on("shell.done", onDone);

    return () => {
      socket.off("shell.request_id", onRequestId);
      socket.off("shell.output", onOutput);
      socket.off("shell.done", onDone);
    };
  }, [socket, stubId, appendChunk, finishEntry]);

  const submit = () => {
    const cmd = input.trim();
    if (!cmd || !socket || running || !isOnline) return;

    // Add to command history
    setCmdHistory((prev) => [cmd, ...prev.slice(0, 99)]);
    setCmdHistoryIdx(-1);

    // Add new history entry
    setHistory((prev) => [...prev, { command: cmd, output: "", exitCode: null, running: true }]);
    setRunning(true);
    setInput("");

    socket.emit("shell.exec", { stub_id: stubId, command: cmd, timeout: 30 });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const newIdx = Math.min(cmdHistoryIdx + 1, cmdHistory.length - 1);
      setCmdHistoryIdx(newIdx);
      if (cmdHistory[newIdx] !== undefined) setInput(cmdHistory[newIdx]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const newIdx = Math.max(cmdHistoryIdx - 1, -1);
      setCmdHistoryIdx(newIdx);
      setInput(newIdx === -1 ? "" : (cmdHistory[newIdx] ?? ""));
    }
  };

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800 bg-gray-950">
        <p className="text-xs text-gray-500 uppercase tracking-wider">Remote Shell</p>
        <div className="flex items-center gap-2">
          {running && (
            <span className="flex items-center gap-1 text-xs text-yellow-400">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
              Running
            </span>
          )}
          {!isOnline && (
            <span className="text-xs text-gray-600">Stub offline</span>
          )}
        </div>
      </div>

      {/* Output area */}
      <div
        className="h-64 overflow-y-auto bg-gray-950 p-3 font-mono text-xs text-gray-300 space-y-2"
        onClick={() => inputRef.current?.focus()}
      >
        {history.length === 0 && (
          <span className="text-gray-700">No commands run yet. Type a command below.</span>
        )}
        {history.map((entry, i) => (
          <div key={i}>
            <div className="text-green-400">$ {entry.command}</div>
            {entry.output && (
              <pre className="whitespace-pre-wrap break-all text-gray-300 leading-relaxed">
                {entry.output}
              </pre>
            )}
            {!entry.running && entry.exitCode !== null && entry.exitCode !== 0 && (
              <div className="text-red-400 text-xs">exit {entry.exitCode}</div>
            )}
            {entry.running && (
              <span className="text-yellow-500 animate-pulse">▋</span>
            )}
          </div>
        ))}
        <div ref={outputEndRef} />
      </div>

      {/* Input area */}
      <div className="flex items-center gap-2 px-3 py-2 border-t border-gray-800 bg-gray-950">
        <span className="text-green-400 font-mono text-xs shrink-0">$</span>
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={running || !isOnline}
          placeholder={isOnline ? "Enter command…" : "Stub offline"}
          className="flex-1 bg-transparent font-mono text-xs text-gray-200 placeholder-gray-600 outline-none disabled:opacity-50"
          autoComplete="off"
          spellCheck={false}
        />
        <button
          onClick={submit}
          disabled={running || !isOnline || !input.trim()}
          className="px-2 py-1 text-xs bg-gray-800 hover:bg-gray-700 text-gray-400 rounded disabled:opacity-40 transition-colors"
        >
          Run
        </button>
      </div>
    </div>
  );
}
