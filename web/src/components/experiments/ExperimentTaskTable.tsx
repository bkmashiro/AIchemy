import { Link } from "react-router-dom";
import type { Task, TaskValidation } from "../../lib/api";

function taskStatusClass(status: Task["status"]): string {
  switch (status) {
    case "running":
      return "text-blue-400";
    case "completed":
      return "text-green-400";
    case "failed":
      return "text-red-400";
    default:
      return "text-gray-500";
  }
}

export function ExperimentTaskTable({
  tasks,
  results,
}: {
  tasks: Task[];
  results: Record<string, TaskValidation>;
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-800">
        <h2 className="text-sm font-medium text-gray-400">
          Tasks ({tasks.length})
        </h2>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-800">
            <th className="text-left px-4 py-2 text-xs text-gray-500 font-medium">Task</th>
            <th className="text-left px-4 py-2 text-xs text-gray-500 font-medium">Status</th>
            <th className="text-left px-4 py-2 text-xs text-gray-500 font-medium">Params</th>
            <th className="text-left px-4 py-2 text-xs text-gray-500 font-medium">Validation</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800/50">
          {tasks.map((task) => {
            const validation = results[task.id];
            return (
              <tr key={task.id} className="hover:bg-gray-800/30">
                <td className="px-4 py-2">
                  <Link
                    to={`/tasks/${task.id}`}
                    className="text-blue-400 hover:text-blue-300 text-xs font-mono"
                  >
                    #{task.seq} {task.display_name}
                  </Link>
                </td>
                <td className={`px-4 py-2 text-xs ${taskStatusClass(task.status)}`}>
                  {task.status}
                </td>
                <td className="px-4 py-2 text-xs text-gray-500 font-mono">
                  {task.param_overrides
                    ? Object.entries(task.param_overrides)
                        .map(([k, v]) => `${k}=${v}`)
                        .join(" ")
                    : ""}
                </td>
                <td className="px-4 py-2 text-xs">
                  {validation ? (
                    <span
                      className={
                        validation.passed ? "text-green-400" : "text-red-400"
                      }
                    >
                      {validation.passed ? "PASSED" : "FAILED"}{" "}
                      {Object.entries(validation.details).map(([m, cr]) => (
                        <span
                          key={m}
                          className={`ml-1 ${
                            cr.ok ? "text-green-600" : "text-red-600"
                          }`}
                        >
                          {m}={cr.value.toFixed(3)}
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="text-gray-600">pending</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
