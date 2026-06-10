import { useEffect, useRef, useState, useCallback } from "react";
import { io, Socket } from "socket.io-client";
import { Stub, Task, GpuStats, SystemStats, getStoredToken, clearToken } from "../lib/api";
import { isActiveTaskStatus, isTerminalTaskStatus } from "../lib/taskStatus";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "";
const MAX_LOSS_POINTS = 200;

export interface TaskMetricPoint {
  step: number;
  value: number;
  ts: string;
}

export interface SocketState {
  stubs: Stub[];
  globalQueue: Task[];
  connected: boolean;
  lossHistory: Map<string, number[]>;
}

// Interval for periodic count correction (ms). WS incremental updates can drift.
const COUNT_REFRESH_INTERVAL_MS = 30_000;

export function useSocket() {
  const [stubs, setStubs] = useState<Stub[]>([]);
  const [globalQueue, setGlobalQueue] = useState<Task[]>([]);
  const [connected, setConnected] = useState(false);
  const [lossHistory, setLossHistory] = useState<Map<string, number[]>>(new Map());
  const socketRef = useRef<Socket | null>(null);
  // Store log buffers in a ref to avoid triggering re-renders for every log line
  const logBuffersRef = useRef<Map<string, string[]>>(new Map());
  // Store live metrics in a ref: task_id → metric_key → [{step, value, ts}]
  const metricsBuffersRef = useRef<Map<string, Map<string, TaskMetricPoint[]>>>(new Map());

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
    const token = getStoredToken();
    const socket = io(`${SERVER_URL}/web`, {
      transports: ["websocket", "polling"],
      auth: { token },
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      // Fetch initial stubs + global queue via REST on connect
      const authFetch = (url: string) =>
        fetch(url, { headers: { Authorization: `Bearer ${token}` } }).then((r) => {
          if (r.status === 401) { clearToken(); window.location.reload(); throw new Error("401"); }
          if (!r.ok) throw new Error(r.status + "");
          return r.json();
        });

      authFetch("/api/stubs")
        .then((data: Stub[]) => { if (Array.isArray(data)) setStubs(data); })
        .catch(() => {});

      authFetch("/api/tasks")
        .then((data: any) => {
          const tasks: Task[] = Array.isArray(data) ? data : (data?.tasks ?? []);
          setGlobalQueue(tasks.filter((t) => !t.stub_id || t.stub_id === ""));
        })
        .catch(() => {});
    });

    socket.on("disconnect", () => setConnected(false));

    // Server → Web: stubs.snapshot — full state on connect
    socket.on("stubs.snapshot", (data: Stub[]) => {
      setStubs(data);
      // Track loss history for running tasks
      for (const stub of data) {
        for (const task of stub.tasks) {
          if (task.progress?.loss !== undefined) {
            appendLoss(task.id, task.progress.loss);
          }
        }
      }
      // Note: global queue (pending tasks with no stub) is fetched via REST on connect
    });

    // Server → Web: stub.update — full stub state
    socket.on("stub.update", (stub: Stub) => {
      setStubs((prev) => {
        const exists = prev.find((s) => s.id === stub.id);
        if (exists) return prev.map((s) => (s.id === stub.id ? stub : s));
        return [...prev, stub];
      });
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

    // Server → Web: task.update — single task update
    socket.on("task.update", (task: Task) => {
      if (task.progress?.loss !== undefined) {
        appendLoss(task.id, task.progress.loss);
      }

      if (!task.stub_id || task.stub_id === "") {
        // No stub — belongs to global queue (or is terminal, remove it)
        if (isTerminalTaskStatus(task.status)) {
          setGlobalQueue((prev) => prev.filter((t) => t.id !== task.id));
        } else {
          setGlobalQueue((prev) => {
            const exists = prev.find((t) => t.id === task.id);
            if (exists) return prev.map((t) => (t.id === task.id ? task : t));
            return [...prev, task];
          });
        }
        return;
      }
      // Remove from global queue when assigned to stub
      setGlobalQueue((prev) => prev.filter((t) => t.id !== task.id));
      setStubs((prev) =>
        prev.map((s) => {
          if (s.id !== task.stub_id) return s;
          if (isTerminalTaskStatus(task.status)) {
            return { ...s, tasks: s.tasks.filter((t) => t.id !== task.id) };
          }
          const exists = s.tasks.find((t) => t.id === task.id);
          const tasks = exists
            ? s.tasks.map((t) => (t.id === task.id ? task : t))
            : [...s.tasks, task];
          return { ...s, tasks };
        })
      );
    });

    // Server → Web: task.deleted — remove task from all lists
    socket.on("task.deleted", ({ task_id }: { task_id: string }) => {
      setGlobalQueue((prev) => prev.filter((t) => t.id !== task_id));
      setStubs((prev) =>
        prev.map((s) => ({ ...s, tasks: s.tasks.filter((t) => t.id !== task_id) }))
      );
    });

    // Server → Web: gpu_stats
    socket.on("gpu_stats", ({ stub_id, stats }: { stub_id: string; stats: GpuStats }) => {
      setStubs((prev) =>
        prev.map((s) => (s.id === stub_id ? { ...s, gpu_stats: stats } : s))
      );
    });

    // Server → Web: system_stats
    socket.on("system_stats", ({ stub_id, stats }: { stub_id: string; stats: SystemStats }) => {
      setStubs((prev) =>
        prev.map((s) => (s.id === stub_id ? { ...s, system_stats: stats } : s))
      );
    });

    // Server → Web: task.log (high-frequency, store in ref only)
    socket.on("task.log", ({ task_id, lines }: { stub_id: string; task_id: string; lines: string[] }) => {
      const prev = logBuffersRef.current.get(task_id) || [];
      logBuffersRef.current.set(task_id, [...prev, ...lines].slice(-500));
    });

    // Server → Web: task.metrics (high-frequency, store in ref only)
    socket.on("task.metrics", ({ task_id, metrics, step }: { task_id: string; metrics: Record<string, number>; step: number }) => {
      if (!metricsBuffersRef.current.has(task_id)) {
        metricsBuffersRef.current.set(task_id, new Map());
      }
      const taskMap = metricsBuffersRef.current.get(task_id)!;
      const ts = new Date().toISOString();
      for (const [key, value] of Object.entries(metrics)) {
        if (!taskMap.has(key)) taskMap.set(key, []);
        const arr = taskMap.get(key)!;
        arr.push({ step, value, ts });
        if (arr.length > 500) arr.splice(0, arr.length - 500);
      }
    });

    // Periodic re-fetch of global queue to correct WS incremental drift.
    // Stubs are fully updated via WS events; only globalQueue needs correction
    // because tasks moving between pending/assigned/blocked may be missed.
    const countRefreshInterval = setInterval(() => {
      fetch("/api/tasks?status_group=active&limit=500", {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((data: any) => {
          if (!data?.tasks) return;
          const tasks: Task[] = data.tasks;
          setGlobalQueue((prev) => {
            // Keep only tasks that are still active and have no stub
            const unassigned = tasks.filter((t) => !t.stub_id || t.stub_id === "");
            // Preserve any tasks in prev that are missing from the API response
            // (could be very new tasks submitted after this fetch)
            const freshIds = new Set(unassigned.map((t) => t.id));
            const keptPrev = prev.filter((t) => !freshIds.has(t.id) && isActiveTaskStatus(t.status));
            return [...unassigned, ...keptPrev];
          });
        })
        .catch(() => {});
    }, COUNT_REFRESH_INTERVAL_MS);

    return () => {
      clearInterval(countRefreshInterval);
      socket.disconnect();
    };
  }, [appendLoss]);

  /** Get live log lines for a task (from WebSocket buffer) */
  const getTaskLogs = useCallback((taskId: string): string[] => {
    return logBuffersRef.current.get(taskId) || [];
  }, []);

  /** Get live metrics for a task (from WebSocket buffer) */
  const getTaskMetricsBuffer = useCallback((taskId: string): Map<string, TaskMetricPoint[]> => {
    return metricsBuffersRef.current.get(taskId) || new Map();
  }, []);

  return {
    stubs,
    globalQueue,
    connected,
    lossHistory,
    logBuffers: logBuffersRef.current,
    socket: socketRef.current,
    getTaskLogs,
    getTaskMetricsBuffer,
  };
}
