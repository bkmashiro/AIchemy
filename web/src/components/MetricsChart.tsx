/**
 * MetricsChart — Live line chart for task metrics (loss, reward, accuracy, etc.)
 *
 * Data comes from two sources:
 *   1. Initial fetch via GET /tasks/:id/metrics (metrics_buffer)
 *   2. Live updates via task.metrics socket events
 */

import { useEffect, useRef, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from "recharts";
import { metricsApi } from "../lib/api";

export interface MetricPoint {
  step: number;
  value: number;
  ts: string;
}

export type MetricsBuffer = Record<string, MetricPoint[]>;

const METRIC_COLORS = [
  "#60a5fa", // blue
  "#34d399", // green
  "#f87171", // red
  "#a78bfa", // purple
  "#fbbf24", // amber
  "#fb923c", // orange
  "#22d3ee", // cyan
  "#f472b6", // pink
];

interface ChartDataPoint {
  step: number;
  [key: string]: number | undefined;
}

function buildChartData(buffer: MetricsBuffer): ChartDataPoint[] {
  const stepSet = new Set<number>();
  for (const points of Object.values(buffer)) {
    for (const p of points) stepSet.add(p.step);
  }
  const steps = Array.from(stepSet).sort((a, b) => a - b);
  return steps.map((step) => {
    const point: ChartDataPoint = { step };
    for (const [key, points] of Object.entries(buffer)) {
      const found = points.find((p) => p.step === step);
      if (found !== undefined) point[key] = found.value;
    }
    return point;
  });
}

interface MetricsChartProps {
  taskId: string;
  /** Socket that emits task.metrics events */
  socket?: { on: (event: string, cb: (...args: any[]) => void) => void; off: (event: string, cb: (...args: any[]) => void) => void } | null;
  height?: number;
}

export default function MetricsChart({ taskId, socket, height = 220 }: MetricsChartProps) {
  const [buffer, setBuffer] = useState<MetricsBuffer>({});
  const [loading, setLoading] = useState(true);
  const bufferRef = useRef<MetricsBuffer>({});

  // Initial fetch
  useEffect(() => {
    setLoading(true);
    metricsApi.getTaskMetrics(taskId)
      .then((data: { metrics_buffer?: MetricsBuffer }) => {
        const mb = data.metrics_buffer || {};
        bufferRef.current = mb;
        setBuffer({ ...mb });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [taskId]);

  // Live socket updates
  useEffect(() => {
    if (!socket) return;

    const handler = (payload: { task_id: string; metrics: Record<string, number>; step: number }) => {
      if (payload.task_id !== taskId) return;
      const { metrics, step } = payload;
      const ts = new Date().toISOString();

      // Merge into local buffer
      const next = { ...bufferRef.current };
      for (const [key, value] of Object.entries(metrics)) {
        if (!next[key]) next[key] = [];
        else next[key] = [...next[key]];
        next[key].push({ step, value, ts });
        // Keep last 500
        if (next[key].length > 500) next[key] = next[key].slice(-500);
      }
      bufferRef.current = next;
      setBuffer(next);
    };

    socket.on("task.metrics", handler);
    return () => { socket.off("task.metrics", handler); };
  }, [socket, taskId]);

  const keys = Object.keys(buffer);

  if (loading) return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 text-xs text-gray-500">
      Loading metrics...
    </div>
  );

  if (keys.length === 0) return null;

  const chartData = buildChartData(buffer);
  if (chartData.length < 2) return null;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-gray-500 uppercase tracking-wider">Metrics</p>
        <span className="text-xs text-gray-600">{chartData.length} pts</span>
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
          <XAxis
            dataKey="step"
            tick={{ fill: "#6b7280", fontSize: 10 }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            tick={{ fill: "#6b7280", fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            width={60}
            tickFormatter={(v: number) => {
              if (Math.abs(v) >= 1000) return v.toExponential(1);
              return v.toPrecision(4);
            }}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "#111827",
              border: "1px solid #374151",
              borderRadius: "6px",
              fontSize: "12px",
            }}
            labelStyle={{ color: "#9ca3af" }}
            labelFormatter={(label) => `step ${label}`}
            formatter={(v: number, name: string) => [
              typeof v === "number" ? v.toPrecision(6) : v,
              name,
            ]}
          />
          {keys.length > 1 && (
            <Legend wrapperStyle={{ fontSize: "11px", color: "#9ca3af" }} />
          )}
          {keys.map((key, i) => (
            <Line
              key={key}
              type="monotone"
              dataKey={key}
              stroke={METRIC_COLORS[i % METRIC_COLORS.length]}
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
