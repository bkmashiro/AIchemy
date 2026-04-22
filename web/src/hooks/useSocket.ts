import { useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { Stub, Task, GpuStats } from "../lib/api";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "";

export interface SocketState {
  stubs: Stub[];
  connected: boolean;
}

export function useSocket() {
  const [stubs, setStubs] = useState<Stub[]>([]);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const socket = io(`${SERVER_URL}/web`, {
      transports: ["websocket", "polling"],
    });
    socketRef.current = socket;

    socket.on("connect", () => setConnected(true));
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

    socket.on("gpu_stats", ({ stub_id, stats }: { stub_id: string; stats: GpuStats }) => {
      setStubs((prev) =>
        prev.map((s) => (s.id === stub_id ? { ...s, gpu_stats: stats } : s))
      );
    });

    socket.on("task.log", ({ stub_id, task_id, lines }: { stub_id: string; task_id: string; lines: string[] }) => {
      setStubs((prev) =>
        prev.map((s) => {
          if (s.id !== stub_id) return s;
          const tasks = s.tasks.map((t) => {
            if (t.id !== task_id) return t;
            const newBuf = [...t.log_buffer, ...lines].slice(-500);
            return { ...t, log_buffer: newBuf };
          });
          return { ...s, tasks };
        })
      );
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  return { stubs, connected, socket: socketRef.current };
}
