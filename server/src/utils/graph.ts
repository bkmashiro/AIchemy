import { Task } from "../types";

/**
 * Detect cycle in task DAG: returns true if adding edges from newTaskId → depends_on would create a cycle.
 * Inserts a virtual node for newTaskId so the DFS can traverse back to it.
 */
export function hasCycleInTaskDag(newTaskId: string, dependsOn: string[], allTasks: Task[]): boolean {
  const taskMap = new Map(allTasks.map((t) => [t.id, t]));
  taskMap.set(newTaskId, { id: newTaskId, depends_on: dependsOn } as Task);

  const visited = new Set<string>();

  function dfs(id: string): boolean {
    if (id === newTaskId) return true; // cycle detected
    if (visited.has(id)) return false;
    visited.add(id);
    const task = taskMap.get(id);
    if (!task?.depends_on) return false;
    return task.depends_on.some(dfs);
  }

  return dependsOn.some(dfs);
}
