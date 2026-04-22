import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

interface DataPoint {
  time: string;
  util: number;
  vram: number;
}

interface Props {
  data: DataPoint[];
}

export default function GpuChart({ data }: Props) {
  return (
    <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
      <h3 className="text-sm font-semibold text-gray-300 mb-3">GPU Stats (last 30 min)</h3>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
          <XAxis dataKey="time" tick={{ fill: "#9CA3AF", fontSize: 10 }} />
          <YAxis domain={[0, 100]} tick={{ fill: "#9CA3AF", fontSize: 10 }} />
          <Tooltip
            contentStyle={{ backgroundColor: "#1F2937", border: "1px solid #374151", borderRadius: "8px" }}
            labelStyle={{ color: "#F9FAFB" }}
          />
          <Legend wrapperStyle={{ fontSize: 12, color: "#9CA3AF" }} />
          <Line type="monotone" dataKey="util" stroke="#3B82F6" name="GPU Util %" dot={false} strokeWidth={2} />
          <Line type="monotone" dataKey="vram" stroke="#8B5CF6" name="VRAM %" dot={false} strokeWidth={2} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export type { DataPoint };
