import { useEffect, useRef, useState, useCallback } from "react";
import { io, Socket } from "socket.io-client";
import { Stub, Task, GpuStats, AnomalyAlert, getStoredToken } from "../lib/api";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "";

export interface MigrationSuggestion {
  id: string;
  task_id: string;
  from_stub_id: string;
  to_stub_id: string;
  reason: string;
  created_at: string;
}

export interface SocketState {
  stubs: Stub[];
  globalQueue: Task[];
  connected: boolean;
  lossHistory: Map<string, number[]>;
  alerts: AnomalyAlert[];
  migrationSuggestions: MigrationSuggestion[];
}

const MAX_LOSS_POINTS = 50;

export function useSocket() {
  const [stubs, setStubs] = useState<Stub[]>([]);
  const [globalQueue, setGlobalQueue] = useState<Task[]>([]);
  const [connected, setConnected] = useState(false);
  const [lossHistory, setLossHistory] = useState<Map<string, number[]>>(new Map());
  const [alerts, setAlerts] = useState<AnomalyAlert[]>([]);
  const [migrationSuggestions, setMigrationSuggestions] = useState<MigrationSuggestion[]>([]);
  const socketRef = useRef<Socket | null>(null);
  const logBuffersRef = useRef<Map<string, string[]>>(new Map());

  const appendLoss = useCallback((taskId: string, loss: number) => {
    setLossHistory((prev) => {
      const next = new Map(prev);
      const arr = next.get(taskId) ? [...next.get(taskId)!] : [];
      arr.push(loss);
      if (arr.length > MAX_LOSS_POINTS) arr.splice(0, arr.length - MAX_LOSS_POINTS);
      next.set(taskId, arr);
      return next;
    });
  }, []);

  useEffect(() => {
    const socket = io(`${SERVER_URL}/web`, {
      transports: ["websocket", "polling"],
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      // Fetch global queue on connect
      fetch("/api/tasks", {
        headers: { Authorization: `Bearer ${getStoredToken()}` },
      })
        .then((r) => r.json())
        .then((tasks: Task[]) =>
          setGlobalQueue(tasks.filter((t) => !t.stub_id || t.stub_id === ""))
        )
        .catch(() => {});

      // Fetch initial alerts
      fetch("/api/alerts", {
        headers: { Authorization: `Bearer ${getStoredToken()}` },
      })
        .then((r) => r.json())
        .then((data: AnomalyAlert[]) => setAlerts(data.filter((a) => !a.resolved)))
        .catch(() => {});

      // Fetch initial migration suggestions
      fetch("/api/migrations/suggestions", {
        headers: { Authorization: `Bearer ${getStoredToken()}` },
      })
        .then((r) => r.json())
        .then((data: MigrationSuggestion[]) => setMigrationSuggestions(data))
        .catch(() => {});
    });
    socket.on("disconnect", () => setConnected(false));

    socket.on("stubs.update", (data: Stub[]) => {
      setStubs(data);
    });

    socket.on("stub.online", (stub: Stub) => {
      setStubs((prev) => {
        const exists = prev.find((s) => s.id === stub.id);
        if (exists) return prev.map((s) => (s.id === stub.id ? stub : s));
        return [...prev, stub];
      });
    });

    socket.on("stub.offline", ({ stub_id }: { stub_id: string }) => {
      setStubs((prev) =>
        prev.map((s) => (s.id === stub_id ? { ...s, status: "offline" as const } : s))
      );
    });

    socket.on("task.update", (task: Task) => {
      // Track loss history
      if (task.progress?.loss !== undefined) {
        appendLoss(task.id, task.progress.loss);
      }

      if (!task.stub_id || task.stub_id === "") {
        setGlobalQueue((prev) => {
          const exists = prev.find((t) => t.id === task.id);
          if (exists) return prev.map((t) => (t.id === task.id ? task : t));
          return [...prev, task];
        });
        return;
      }
      // Task has a stub_id — remove from globalQueue if it was there
      setGlobalQueue((prev) => prev.filter((t) => t.id !== task.id));
      setStubs((prev) =>
        prev.map((s) => {
          if (s.id !== task.stub_id) return s;
          const exists = s.tasks.find((t) => t.id === task.id);
          const tasks = exists
            ? s.tasks.map((t) => (t.id === task.id ? task : t))
            : [...s.tasks, task];
          return { ...s, tasks };
        })
      );
    });

    socket.on("task.deleted", ({ task_id }: { task_id: string }) => {
      setGlobalQueue((prev) => prev.filter((t) => t.id !== task_id));
      setStubs((prev) =>
        prev.map((s) => ({ ...s, tasks: s.tasks.filter((t) => t.id !== task_id) }))
      );
    });

    socket.on("gpu_stats", ({ stub_id, stats }: { stub_id: string; stats: GpuStats }) => {
      setStubs((prev) =>
        prev.map((s) => (s.id === stub_id ? { ...s, gpu_stats: stats } : s))
      );
    });

    // task.log is high-frequency; store in a separate ref to avoid re-rendering the whole tree
    socket.on("task.log", ({ task_id, lines }: { stub_id: string; task_id: string; lines: string[] }) => {
      const prev = logBuffersRef.current.get(task_id) || [];
      logBuffersRef.current.set(task_id, [...prev, ...lines].slice(-500));
    });

    // Anomaly alerts
    socket.on("anomaly.alert", (alert: AnomalyAlert) => {
      setAlerts((prev) => {
        const exists = prev.find((a) => a.id === alert.id);
        if (exists) return prev.map((a) => (a.id === alert.id ? alert : a));
        return [alert, ...prev];
      });
    });

    // Migration suggestions
    socket.on("migration.suggestion", (suggestion: MigrationSuggestion) => {
      setMigrationSuggestions((prev) => {
        const exists = prev.find((s) => s.id === suggestion.id);
        if (exists) return prev;
        return [suggestion, ...prev];
      });
    });

    return () => {
      socket.disconnect();
    };
  }, [appendLoss]);

  const dismissAlert = useCallback((id: string) => {
    setAlerts((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const resolveAlert = useCallback((id: string) => {
    setAlerts((prev) => prev.map((a) => (a.id === id ? { ...a, resolved: true } : a)));
  }, []);

  const dismissMigration = useCallback((id: string) => {
    setMigrationSuggestions((prev) => prev.filter((s) => s.id !== id));
  }, []);

  return {
    stubs,
    globalQueue,
    connected,
    lossHistory,
    logBuffers: logBuffersRef.current,
    socket: socketRef.current,
    alerts,
    migrationSuggestions,
    dismissAlert,
    resolveAlert,
    dismissMigration,
  };
}
