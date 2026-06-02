import { statusBadgeClass } from "./experimentDetailUtils";

export function StatusBadge({
  status,
  className = "",
}: {
  status: string;
  className?: string;
}) {
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded border ${statusBadgeClass(status)} ${className}`}
    >
      {status.toUpperCase()}
    </span>
  );
}
