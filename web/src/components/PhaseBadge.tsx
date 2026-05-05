const PHASE_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  warmup:     { bg: "bg-blue-900/30",   text: "text-blue-300",   border: "border-blue-700/40" },
  training:   { bg: "bg-green-900/30",  text: "text-green-400",  border: "border-green-700/40" },
  eval:       { bg: "bg-yellow-900/30", text: "text-yellow-300", border: "border-yellow-700/40" },
  checkpoint: { bg: "bg-purple-900/30", text: "text-purple-300", border: "border-purple-700/40" },
  cooldown:   { bg: "bg-gray-800/40",   text: "text-gray-400",   border: "border-gray-700/40" },
};

interface Props {
  phase: string;
}

export default function PhaseBadge({ phase }: Props) {
  const cfg = PHASE_COLORS[phase] || { bg: "bg-gray-800/30", text: "text-gray-400", border: "border-gray-600/40" };
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium tracking-wide border ${cfg.bg} ${cfg.text} ${cfg.border}`}>
      {phase}
    </span>
  );
}
