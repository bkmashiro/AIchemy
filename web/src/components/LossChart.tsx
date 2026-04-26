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

export interface LossDataPoint {
  step: number;
  loss: number;
  [key: string]: number;
}

interface SingleSeriesProps {
  data: number[];
  height?: number;
  startedAt?: string;
  totalSteps?: number;
}

export function LossChart({ data, height = 160, startedAt, totalSteps }: SingleSeriesProps) {
  if (!data || data.length < 2) return null;

  const chartData: LossDataPoint[] = data.map((v, i) => ({ step: i + 1, loss: v }));
  const minLoss = Math.min(...data);
  const maxLoss = Math.max(...data);
  const curLoss = data[data.length - 1];

  let eta: string | null = null;
  if (startedAt && totalSteps && data.length > 0) {
    const elapsed = Date.now() - new Date(startedAt).getTime();
    if (elapsed > 0 && data.length < totalSteps) {
      const speed = data.length / elapsed;
      const remainMs = (totalSteps - data.length) / speed;
      const m = Math.round(remainMs / 60000);
      eta = m >= 60 ? `~${Math.floor(m / 60)}h${m % 60}m` : `~${m}m`;
    }
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-gray-500 uppercase tracking-wider">
          Loss
          <span className="ml-3 text-gray-600 normal-case">
            min={minLoss.toFixed(4)} cur={curLoss.toFixed(4)}
          </span>
        </p>
        <div className="flex items-center gap-3 text-xs text-gray-600">
          {eta && <span className="text-cyan-400">ETA {eta}</span>}
          <span>{data.length} pts</span>
        </div>
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
            domain={[
              minLoss === maxLoss ? minLoss - Math.max(Math.abs(minLoss) * 0.1, 1e-6) : minLoss * 0.98,
              minLoss === maxLoss ? maxLoss + Math.max(Math.abs(maxLoss) * 0.1, 1e-6) : maxLoss * 1.02,
            ]}
            tick={{ fill: "#6b7280", fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            width={55}
            tickFormatter={(v: number) => v.toFixed(3)}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "#111827",
              border: "1px solid #374151",
              borderRadius: "6px",
              fontSize: "12px",
            }}
            labelStyle={{ color: "#9ca3af" }}
            itemStyle={{ color: "#60a5fa" }}
            formatter={(v: number) => [v.toFixed(6), "loss"]}
            labelFormatter={(label) => `step ${label}`}
          />
          <Line
            type="monotone"
            dataKey="loss"
            stroke="#60a5fa"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export interface MultiSeriesPoint {
  step: number;
  [taskId: string]: number;
}

interface MultiSeriesProps {
  series: Array<{ id: string; label: string; color?: string; data: number[] }>;
  height?: number;
}

const SERIES_COLORS = [
  "#60a5fa", // blue
  "#34d399", // green
  "#f87171", // red
  "#a78bfa", // purple
  "#fbbf24", // amber
  "#fb923c", // orange
  "#22d3ee", // cyan
];

export function MultiLossChart({ series, height = 240 }: MultiSeriesProps) {
  if (!series || series.length === 0) return null;

  const maxLen = Math.max(...series.map((s) => s.data.length));
  const chartData: MultiSeriesPoint[] = Array.from({ length: maxLen }, (_, i) => {
    const point: MultiSeriesPoint = { step: i + 1 };
    for (const s of series) {
      if (i < s.data.length) point[s.id] = s.data[i];
    }
    return point;
  });

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
      <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Loss Curves</p>
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
            width={55}
            tickFormatter={(v: number) => v.toFixed(3)}
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
            formatter={(v: number, name: string) => {
              const s = series.find((x) => x.id === name);
              return [v.toFixed(6), s?.label ?? name];
            }}
          />
          <Legend
            wrapperStyle={{ fontSize: "11px", color: "#9ca3af" }}
            formatter={(value) => {
              const s = series.find((x) => x.id === value);
              return s?.label ?? value;
            }}
          />
          {series.map((s, i) => (
            <Line
              key={s.id}
              type="monotone"
              dataKey={s.id}
              stroke={s.color || SERIES_COLORS[i % SERIES_COLORS.length]}
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

export { SERIES_COLORS };
