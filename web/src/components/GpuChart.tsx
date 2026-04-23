import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

export interface DataPoint {
  time: string;
  util: number;
  vram: number;
}

interface Props {
  data: DataPoint[];
  height?: number;
}

export default function GpuChart({ data, height = 160 }: Props) {
  // Show only last N points for readability
  const displayed = data.slice(-40);

  return (
    <div className="bg-gray-900 rounded-xl px-4 pt-4 pb-2 border border-gray-800">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">GPU History</h3>
        <div className="flex items-center gap-4 text-xs text-gray-500">
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-0.5 bg-blue-500 inline-block rounded" />
            Util%
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-0.5 bg-purple-500 inline-block rounded" />
            VRAM%
          </span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={displayed} margin={{ top: 4, right: 4, bottom: 0, left: -24 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1F2937" vertical={false} />
          <XAxis
            dataKey="time"
            tick={{ fill: "#4B5563", fontSize: 9 }}
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            domain={[0, 100]}
            tick={{ fill: "#4B5563", fontSize: 9 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => `${v}%`}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "#111827",
              border: "1px solid #374151",
              borderRadius: "8px",
              fontSize: "12px",
            }}
            labelStyle={{ color: "#9CA3AF" }}
            itemStyle={{ color: "#D1D5DB" }}
          />
          <Line
            type="monotone"
            dataKey="util"
            stroke="#3B82F6"
            name="GPU Util"
            dot={false}
            strokeWidth={1.5}
            activeDot={{ r: 3 }}
          />
          <Line
            type="monotone"
            dataKey="vram"
            stroke="#8B5CF6"
            name="VRAM"
            dot={false}
            strokeWidth={1.5}
            activeDot={{ r: 3 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
