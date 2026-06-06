import { Link } from "react-router-dom";
import type { ExperimentDetail } from "../../lib/api";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-gray-600 mb-0.5">
        {label}
      </div>
      <div>{children}</div>
    </div>
  );
}

export function IntentCard({ exp }: { exp: ExperimentDetail }) {
  const hasIntent =
    exp.hypothesis ||
    exp.expected_outcome ||
    exp.family ||
    exp.parent_name ||
    exp.fork_reason;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <h2 className="text-sm font-medium text-gray-400 mb-3">Intent</h2>
      {!hasIntent && <p className="text-xs text-gray-600">No intent recorded</p>}
      <div className="space-y-2 text-xs">
        {exp.family && (
          <Field label="Family">
            <span className="font-mono text-gray-300">{exp.family}</span>
          </Field>
        )}
        {exp.parent_name && (
          <Field label="Parent">
            {exp.parent_id ? (
              <Link
                to={`/experiments/${exp.parent_id}`}
                className="text-blue-400 hover:text-blue-300 font-mono"
              >
                {exp.parent_name}
              </Link>
            ) : (
              <span className="font-mono text-gray-300">{exp.parent_name}</span>
            )}
          </Field>
        )}
        {exp.hypothesis && (
          <Field label="Hypothesis">
            <p className="text-gray-300 whitespace-pre-wrap">{exp.hypothesis}</p>
          </Field>
        )}
        {exp.expected_outcome && (
          <Field label="Expected">
            <p className="text-gray-300 whitespace-pre-wrap">
              {exp.expected_outcome}
            </p>
          </Field>
        )}
        {exp.fork_reason && (
          <Field label="Fork reason">
            <p className="text-gray-300 whitespace-pre-wrap">{exp.fork_reason}</p>
          </Field>
        )}
      </div>
    </div>
  );
}
