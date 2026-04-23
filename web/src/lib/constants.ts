export const STATUS_COLORS: Record<string, { text: string; bg: string; border: string }> = {
  running: { text: "text-green-400", bg: "bg-green-500/10", border: "border-green-500/30" },
  completed: { text: "text-blue-400", bg: "bg-blue-500/10", border: "border-blue-500/30" },
  failed: { text: "text-red-400", bg: "bg-red-500/10", border: "border-red-500/30" },
  killed: { text: "text-gray-400", bg: "bg-gray-500/10", border: "border-gray-500/30" },
  queued: { text: "text-yellow-400", bg: "bg-yellow-500/10", border: "border-yellow-500/30" },
  paused: { text: "text-orange-400", bg: "bg-orange-500/10", border: "border-orange-500/30" },
  waiting: { text: "text-cyan-400", bg: "bg-cyan-500/10", border: "border-cyan-500/30" },
  blocked: { text: "text-red-300", bg: "bg-red-500/10", border: "border-red-500/30" },
  dispatched: { text: "text-emerald-400", bg: "bg-emerald-500/10", border: "border-emerald-500/30" },
  migrating: { text: "text-purple-400", bg: "bg-purple-500/10", border: "border-purple-500/30" },
  interrupted: { text: "text-amber-400", bg: "bg-amber-500/10", border: "border-amber-500/30" },
  completed_with_errors: { text: "text-yellow-300", bg: "bg-yellow-500/10", border: "border-yellow-500/30" },
};
