import { Stub } from "../lib/api";
import StubCard from "../components/StubCard";

interface Props {
  stubs: Stub[];
}

export default function Dashboard({ stubs }: Props) {
  const totalRunning = stubs.reduce(
    (acc, s) => acc + s.tasks.filter((t) => t.status === "running").length,
    0
  );
  const totalQueued = stubs.reduce(
    (acc, s) => acc + s.tasks.filter((t) => t.status === "queued").length,
    0
  );
  const onlineStubs = stubs.filter((s) => s.status === "online").length;

  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-6">Dashboard</h1>

      {/* Summary stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <StatCard label="Online Stubs" value={onlineStubs} color="text-green-400" />
        <StatCard label="Total Stubs" value={stubs.length} color="text-blue-400" />
        <StatCard label="Running Tasks" value={totalRunning} color="text-yellow-400" />
        <StatCard label="Queued Tasks" value={totalQueued} color="text-purple-400" />
      </div>

      {/* Stubs grid */}
      {stubs.length === 0 ? (
        <div className="text-center py-20 text-gray-600">
          <p className="text-4xl mb-4">🖥️</p>
          <p className="text-lg">No stubs connected yet</p>
          <p className="text-sm mt-2">Start a stub daemon to get started</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {stubs.map((stub) => (
            <StubCard key={stub.id} stub={stub} />
          ))}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
      <p className="text-sm text-gray-400">{label}</p>
      <p className={`text-3xl font-bold mt-1 ${color}`}>{value}</p>
    </div>
  );
}
