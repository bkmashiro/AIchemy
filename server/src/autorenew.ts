/**
 * autorenew.ts — SLURM auto-renew for stubs near walltime expiry.
 *
 * Every 60s, checks SLURM stubs:
 *   - type === "slurm"
 *   - walltime_remaining < 15min (reported by stub via heartbeat/system_stats)
 *   - pending/queued tasks exist that match the stub's tags
 *   - auto_renew === true
 *   - deploy_config is saved
 *
 * If all conditions met: SSH to login node, submit sbatch using saved deploy_config.
 * Uses ALCHEMY_SSH_KEY_PATH env var for SSH key.
 *
 * Failure → warn + Discord alert (if configured), never crash.
 */

import { exec } from "child_process";
import { promisify } from "util";
import { store } from "./store";
import { logger } from "./log";

const execAsync = promisify(exec);

const SSH_KEY_PATH = process.env.ALCHEMY_SSH_KEY_PATH || "";
const AUTO_RENEW_INTERVAL_MS = 60_000;
const WALLTIME_THRESHOLD_S = 15 * 60; // 15 minutes

// Track which stubs have already had a renewal submitted (prevent duplicates)
const renewalInFlight: Set<string> = new Set();

function hasPendingTasksForStub(stubId: string, tags?: string[]): boolean {
  const allTasks = store.getAllTasks();
  const pending = allTasks.filter((t) => t.status === "pending" || t.status === "queued");

  if (pending.length === 0) return false;

  // If no tags constraint, any pending task counts
  if (!tags || tags.length === 0) return pending.length > 0;

  // Check if any pending task's target_tags is a subset of stub's tags
  const stubTagSet = new Set(tags);
  return pending.some((t) => {
    if (!t.target_tags || t.target_tags.length === 0) return true; // no constraint = matches all
    return t.target_tags.every((tag) => stubTagSet.has(tag));
  });
}

function buildSbatchScript(deployConfig: NonNullable<import("./types").Stub["deploy_config"]>): string {
  const directives: string[] = [
    "#!/bin/bash",
  ];

  if (deployConfig.partition) directives.push(`#SBATCH --partition=${deployConfig.partition}`);
  if (deployConfig.gres) directives.push(`#SBATCH --gres=${deployConfig.gres}`);
  if (deployConfig.mem) directives.push(`#SBATCH --mem=${deployConfig.mem}`);
  if (deployConfig.time) directives.push(`#SBATCH --time=${deployConfig.time}`);
  if (deployConfig.qos) directives.push(`#SBATCH --qos=${deployConfig.qos}`);
  directives.push(`#SBATCH --job-name=train_alchemy`);
  directives.push(`#SBATCH --output=/tmp/alchemy_stub_%j.out`);
  directives.push("");

  const pythonPath = deployConfig.python_path || "python";
  const serverUrl = deployConfig.server_url || "";
  const token = deployConfig.token || "";
  const maxConcurrent = deployConfig.max_concurrent || 1;
  const envSetup = deployConfig.env_setup ? `"${deployConfig.env_setup}"` : '""';
  const defaultCwd = deployConfig.default_cwd ? `"${deployConfig.default_cwd}"` : "";

  directives.push("while true; do");
  let stubCmd = `    ${pythonPath} -m alchemy_stub --server '${serverUrl}' --token '${token}' --max-concurrent ${maxConcurrent}`;
  if (deployConfig.env_setup) stubCmd += ` --env-setup ${envSetup}`;
  if (deployConfig.default_cwd) stubCmd += ` --default-cwd ${defaultCwd}`;
  directives.push(stubCmd);
  directives.push('    echo "Stub exited, restarting in 5s..."');
  directives.push("    sleep 5");
  directives.push("done");

  return directives.join("\n");
}

async function sshExec(host: string, user: string | undefined, command: string): Promise<string> {
  const userPrefix = user ? `${user}@` : "";
  const keyFlag = SSH_KEY_PATH ? `-i ${SSH_KEY_PATH}` : "";
  const sshCmd = `ssh ${keyFlag} -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${userPrefix}${host} ${JSON.stringify(command)}`;
  const { stdout } = await execAsync(sshCmd, { timeout: 30_000 });
  return stdout.trim();
}

async function checkForExistingPendingSbatch(host: string, user: string | undefined): Promise<boolean> {
  try {
    const result = await sshExec(host, user, `squeue -u ${user || "$(whoami)"} -h --state=PD -o "%j" | grep -c "^train_alchemy$" || true`);
    const count = parseInt(result, 10);
    return count > 0;
  } catch {
    return false; // Assume no duplicate on error
  }
}

async function submitAutoRenew(stubId: string): Promise<void> {
  if (renewalInFlight.has(stubId)) return;

  const stub = store.getStub(stubId);
  if (!stub) return;
  if (!stub.auto_renew || stub.type !== "slurm") return;
  if (!stub.deploy_config) {
    logger.warn("slurm.renew_skipped", { stub: stub.name, reason: "no_deploy_config" });
    return;
  }

  const dc = stub.deploy_config;
  if (dc.type !== "slurm") return;

  renewalInFlight.add(stubId);
  try {
    // Check for existing pending sbatch to avoid duplicates
    const hasDuplicate = await checkForExistingPendingSbatch(dc.ssh_host, dc.ssh_user);
    if (hasDuplicate) {
      logger.warn("slurm.renew_skipped", { stub: stub.name, reason: "duplicate_pending_job" });
      return;
    }

    const script = buildSbatchScript(dc);
    const tmpScript = `/tmp/alchemy_autorenew_${stubId}.sh`;
    const userPrefix = dc.ssh_user ? `${dc.ssh_user}@` : "";
    const keyFlag = SSH_KEY_PATH ? `-i ${SSH_KEY_PATH}` : "";

    // Write sbatch script to remote via heredoc
    const writeCmd = `ssh ${keyFlag} -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${userPrefix}${dc.ssh_host} "cat > ${tmpScript}" <<'ALCHEMY_HEREDOC'\n${script}\nALCHEMY_HEREDOC`;
    await execAsync(writeCmd, { timeout: 30_000 });

    // Submit sbatch
    const result = await sshExec(dc.ssh_host, dc.ssh_user, `sbatch ${tmpScript} && rm -f ${tmpScript}`);
    const jobIdMatch = result.match(/Submitted batch job (\d+)/);
    const newJobId = jobIdMatch ? jobIdMatch[1] : "unknown";

    logger.info("slurm.auto_renew", { stub: stub.name, old_job: stub.slurm_job_id, new_job: newJobId });
  } catch (err) {
    logger.warn("slurm.renew_failed", { stub: stub.name, error: String(err) });
  } finally {
    renewalInFlight.delete(stubId);
  }
}

async function checkAutoRenew(): Promise<void> {
  const stubs = store.getAllStubs();

  for (const stub of stubs) {
    if (stub.type !== "slurm") continue;
    if (!stub.auto_renew) continue;
    if (!stub.deploy_config) continue;
    if (stub.status !== "online") continue;

    // Check walltime_remaining (reported via system_stats or gpu_stats extension)
    // SPEC: stub reports walltime_remaining; we check if < 15min
    // For now we use a stub field if available
    const walltimeRemaining = (stub as any).walltime_remaining_s as number | undefined;
    if (walltimeRemaining === undefined || walltimeRemaining >= WALLTIME_THRESHOLD_S) continue;

    // Check pending tasks
    if (!hasPendingTasksForStub(stub.id, stub.tags)) continue;

    // Submit renewal (async, non-blocking)
    submitAutoRenew(stub.id).catch((err) => {
      logger.error("slurm.renew_error", { stub: stub.name, error: String(err) });
    });
  }
}

export function startAutoRenew(): void {
  if (!SSH_KEY_PATH) {
    logger.info("autorenew.disabled", { reason: "ALCHEMY_SSH_KEY_PATH not set" });
    return;
  }
  setInterval(() => {
    checkAutoRenew().catch((err) => {
      logger.error("autorenew.check_failed", { error: String(err) });
    });
  }, AUTO_RENEW_INTERVAL_MS);
  logger.info("autorenew.started", { interval_s: AUTO_RENEW_INTERVAL_MS / 1000, ssh_key: SSH_KEY_PATH });
}
