/**
 * git-tracking.ts — Git-based experiment manifest tracking.
 *
 * All operations are fire-and-forget via stub.exec (WebSocket).
 * Failures are logged as warnings and never block task lifecycle.
 */

import { v4 as uuidv4 } from "uuid";
import { Namespace } from "socket.io";
import { store } from "./store";
import { Experiment, Task, ExecRequestPayload, ExecResponsePayload } from "./types";
import { logger } from "./log";

// ─── Core exec helper ─────────────────────────────────────────────────────────

/**
 * Run a shell command on a stub via WebSocket exec.request.
 * Returns the response payload. Throws on timeout or socket error.
 */
async function execOnStub(
  stubId: string,
  command: string,
  timeoutMs: number,
  stubNs: Namespace,
): Promise<ExecResponsePayload> {
  const stub = store.getStub(stubId);
  if (!stub || stub.status !== "online" || !stub.socket_id) {
    throw new Error(`stub ${stubId} offline`);
  }

  const socket = stubNs.sockets.get(stub.socket_id);
  if (!socket || !socket.connected) {
    throw new Error(`stub ${stubId} socket not connected`);
  }

  const requestId = `git_${stubId}_${uuidv4().slice(0, 8)}`;
  const payload: ExecRequestPayload = {
    request_id: requestId,
    command,
    timeout_s: Math.ceil(timeoutMs / 1000),
  };

  return new Promise<ExecResponsePayload>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs + 5_000);
    socket.emit("exec.request", payload, (response: ExecResponsePayload) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

// ─── Minimal YAML serializer ──────────────────────────────────────────────────

/**
 * Serialize a plain object to YAML. Handles strings, numbers, booleans,
 * null, arrays, and nested objects. No external dependency needed.
 */
function toYaml(obj: Record<string, any>, indent = 0): string {
  const pad = "  ".repeat(indent);
  const lines: string[] = [];

  for (const [key, val] of Object.entries(obj)) {
    if (val === null || val === undefined) {
      lines.push(`${pad}${key}: null`);
    } else if (typeof val === "boolean" || typeof val === "number") {
      lines.push(`${pad}${key}: ${val}`);
    } else if (typeof val === "string") {
      // Quote strings that look like special yaml values or contain special chars
      const needsQuote = /[:#\[\]{},&*?|<>=!%@`]/.test(val) || val === "" || /^(true|false|null|yes|no)$/i.test(val);
      lines.push(`${pad}${key}: ${needsQuote ? `"${val.replace(/"/g, '\\"')}"` : val}`);
    } else if (Array.isArray(val)) {
      if (val.length === 0) {
        lines.push(`${pad}${key}: []`);
      } else {
        lines.push(`${pad}${key}:`);
        for (const item of val) {
          if (typeof item === "object" && item !== null) {
            lines.push(`${pad}  -`);
            lines.push(toYaml(item, indent + 2).replace(/^/gm, "  "));
          } else {
            lines.push(`${pad}  - ${item}`);
          }
        }
      }
    } else if (typeof val === "object") {
      lines.push(`${pad}${key}:`);
      lines.push(toYaml(val, indent + 1));
    }
  }

  return lines.join("\n");
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Create initial experiment manifest YAML via stub.exec.
 * Fire-and-forget — call without await.
 */
export async function initExperimentManifest(
  exp: Experiment,
  stubId: string,
  stubNs: Namespace,
): Promise<void> {
  const repoPath = exp.git_repo_path;
  if (!repoPath) {
    logger.warn("git-tracking.init-skipped", { experiment: exp.name, reason: "no git_repo_path" });
    return;
  }

  const manifest: Record<string, any> = {
    name: exp.name,
    parent: exp.parent_name || null,
    created_at: exp.created_at,
    config: null,
    config_diff: exp.config_diff || null,
    artifacts: {},
    metrics: {},
  };

  const yaml = toYaml(manifest);
  const manifestPath = `experiments/${exp.name}.yaml`;

  // Use heredoc to write the file — avoids shell quoting issues with the content
  const command = [
    `cd ${repoPath}`,
    `mkdir -p experiments`,
    `cat > ${manifestPath} << 'ALCHEMY_MANIFEST_EOF'`,
    yaml,
    `ALCHEMY_MANIFEST_EOF`,
    `git add ${manifestPath}`,
    `git commit -m "alchemy: init experiment ${exp.name}" || true`,
  ].join(" && \\\n");

  try {
    const result = await execOnStub(stubId, command, 15_000, stubNs);
    if (result.exit_code !== 0) {
      logger.warn("git-tracking.init-nonzero", {
        experiment: exp.name,
        exit_code: result.exit_code,
        stderr: result.stderr.slice(0, 200),
      });
    } else {
      logger.info("git-tracking.init-ok", { experiment: exp.name });
    }
  } catch (e) {
    logger.warn("git-tracking.init-failed", { experiment: exp.name, error: String(e) });
  }
}

/**
 * Update the experiment manifest artifacts section and auto-commit via stub.exec.
 * Fire-and-forget — call without await.
 */
export async function updateExperimentManifest(
  exp: Experiment,
  task: Task,
  stubId: string,
  stubNs: Namespace,
): Promise<void> {
  const repoPath = exp.git_repo_path || task.cwd;
  if (!repoPath) {
    logger.warn("git-tracking.update-skipped", { experiment: exp.name, task: task.id, reason: "no repo path" });
    return;
  }

  const manifestPath = `experiments/${exp.name}.yaml`;
  // Determine artifact phase: prefer task.ref, then infer from name
  const phase = task.ref || (task.name?.startsWith("eval_") ? "eval" : "train");

  const exitCode = task.exit_code !== undefined ? task.exit_code : "null";
  const finishedAt = task.finished_at || "";
  const runDir = task.run_dir || "";

  // Python script to update the manifest in-place
  const updateScript = `python3 -c "
import yaml, sys
path = '${manifestPath}'
try:
    with open(path) as f:
        m = yaml.safe_load(f) or {}
except FileNotFoundError:
    m = {'name': '${exp.name}', 'artifacts': {}}

if 'artifacts' not in m:
    m['artifacts'] = {}

m['artifacts']['${phase}'] = {
    'status': '${task.status}',
    'task_id': '${task.id}',
    'exit_code': ${exitCode},
    'finished_at': '${finishedAt}',
    'run_dir': '${runDir}',
}

if '${phase}' == 'eval' and ${task.exit_code ?? -1} == 0:
    import json, glob as _glob
    for jf in _glob.glob('results/eval_${exp.name}*.json'):
        try:
            with open(jf) as f:
                metrics = json.load(f)
            m.setdefault('metrics', {}).update({k: v for k, v in metrics.items() if k.startswith('silhouette')})
            m['artifacts']['eval']['results_json'] = jf
            break
        except Exception:
            pass

with open(path, 'w') as f:
    yaml.dump(m, f, default_flow_style=False, sort_keys=False)
"`;

  const commitMsg = `alchemy: ${task.name || task.id} ${task.status} (exit ${task.exit_code ?? "?"})`;

  const command = [
    `cd ${repoPath}`,
    `mkdir -p experiments`,
    updateScript,
    `git add ${manifestPath}`,
    `git commit -m "${commitMsg}" 2>/dev/null || true`,
  ].join(" && \\\n");

  try {
    const result = await execOnStub(stubId, command, 20_000, stubNs);
    if (result.exit_code !== 0) {
      logger.warn("git-tracking.update-nonzero", {
        experiment: exp.name,
        task: task.id,
        exit_code: result.exit_code,
        stderr: result.stderr.slice(0, 200),
      });
    } else {
      logger.info("git-tracking.update-ok", { experiment: exp.name, task: task.id, phase });
    }
  } catch (e) {
    logger.warn("git-tracking.update-failed", { experiment: exp.name, task: task.id, error: String(e) });
  }
}

/**
 * Read the manifest YAML content via stub.exec (cat).
 * Returns the raw YAML string, or throws on error.
 */
export async function readExperimentManifest(
  exp: Experiment,
  stubId: string,
  stubNs: Namespace,
): Promise<string> {
  const repoPath = exp.git_repo_path;
  if (!repoPath) throw new Error("no git_repo_path on experiment");

  const manifestPath = `experiments/${exp.name}.yaml`;
  const command = `cd ${repoPath} && cat ${manifestPath}`;

  const result = await execOnStub(stubId, command, 10_000, stubNs);
  if (result.exit_code !== 0) {
    throw new Error(`cat failed (exit ${result.exit_code}): ${result.stderr}`);
  }
  return result.stdout;
}
