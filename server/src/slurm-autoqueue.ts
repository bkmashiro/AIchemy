import { exec } from "child_process";
import { promisify } from "util";
import { v4 as uuidv4 } from "uuid";
import { store } from "./store";
import { SlurmAccount, AutoQueueConfig } from "./types";
import { Namespace } from "socket.io";

const execAsync = promisify(exec);

// Track last task activity per account for idle timeout
const lastActivity: Map<string, number> = new Map();

export function updateAccountActivity(accountId: string): void {
  lastActivity.set(accountId, Date.now());
}

async function sshExec(sshTarget: string, command: string): Promise<{ stdout: string; stderr: string }> {
  return execAsync(`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${sshTarget} '${command}'`, {
    timeout: 30_000,
  });
}

function generateSbatchScript(
  account: SlurmAccount,
  serverUrl: string,
  token: string,
  partition?: string,
): string {
  const part = partition || account.partitions[0] || "gpu";
  return `#!/bin/bash
#SBATCH --gres=gpu:1
#SBATCH --mem=${account.default_mem}
#SBATCH --time=${account.default_walltime}
#SBATCH --partition=${part}
#SBATCH --job-name=alchemy-stub

${account.stub_command} \\
  --server ${serverUrl} \\
  --token ${token} \\
  --slurm-account-id ${account.id}
`;
}

async function countPendingSlurmJobs(account: SlurmAccount): Promise<number> {
  try {
    const { stdout } = await sshExec(
      account.ssh_target,
      `squeue -u $(whoami) --format="%j %t" | grep alchemy-stub | grep PD | wc -l`,
    );
    return parseInt(stdout.trim(), 10) || 0;
  } catch {
    console.warn(`[autoqueue] Failed to check squeue for account ${account.name}`);
    return 0;
  }
}

async function submitSlurmJob(account: SlurmAccount, serverUrl: string): Promise<string | null> {
  // Get or create a token for this account
  let token = store.getAllTokens().find((t) => t.label === `autoqueue-${account.name}`);
  if (!token) {
    token = {
      token: uuidv4(),
      created_at: new Date().toISOString(),
      label: `autoqueue-${account.name}`,
    };
    store.addToken(token);
  }

  const script = generateSbatchScript(account, serverUrl, token.token);

  try {
    const { stdout } = await sshExec(
      account.ssh_target,
      `sbatch <<'SBATCH_EOF'\n${script}\nSBATCH_EOF`,
    );
    const match = stdout.match(/Submitted batch job (\d+)/);
    const jobId = match ? match[1] : null;
    console.log(`[autoqueue] Submitted SLURM job for ${account.name}: ${jobId || stdout.trim()}`);
    return jobId;
  } catch (err) {
    console.error(`[autoqueue] Failed to submit job for ${account.name}:`, err);
    return null;
  }
}

/**
 * Auto-queue logic with 4-parameter model:
 *   max_running (a): target number of active/online stubs
 *   max_pending (b): target number of queued SLURM jobs
 *   qos_running_limit (c): hard QOS cap on running jobs
 *   qos_pending_limit (d): hard QOS cap on pending jobs
 *
 * Strategy:
 *   running_deficit = min(max_running, qos_running_limit) - current_online_stubs
 *   pending_deficit = min(max_pending, qos_pending_limit) - current_pending_jobs
 *   total_to_submit = max(0, running_deficit + pending_deficit)
 *   But also capped so: current_pending + submit <= min(max_pending, qos_pending_limit)
 *
 * Submitted jobs start as pending, then become running when SLURM schedules them.
 * So we only submit to fill the *pending* pool — running stubs come from pending graduating.
 */
async function checkAutoQueue(config: AutoQueueConfig, webNs: Namespace): Promise<number> {
  if (!config.enabled) return 0;

  const account = store.getSlurmAccount(config.account_id);
  if (!account) return 0;

  // Current state
  const onlineStubs = store.getAllStubs().filter(
    (s) => s.slurm_account_id === account.id && s.status === "online",
  ).length;
  const pendingJobs = await countPendingSlurmJobs(account);

  // How many running slots do we want filled?
  const targetRunning = Math.min(config.max_running, config.qos_running_limit);
  // How many are missing from the running pool?
  const runningDeficit = Math.max(0, targetRunning - onlineStubs);

  // How many pending slots do we want?
  const targetPending = Math.min(config.max_pending, config.qos_pending_limit);
  // Pending should cover: its own target + any running deficit (pending graduates to running)
  const desiredPending = Math.min(targetPending, runningDeficit + targetPending);
  const pendingDeficit = Math.max(0, desiredPending - pendingJobs);

  if (pendingDeficit <= 0) return 0;

  // Check if there's actual work to do
  const allTasks = store.getAllTasks();
  const hasPendingWork = allTasks.some((t) => ["queued", "waiting"].includes(t.status));
  const hasRunningWork = allTasks.some((t) => t.status === "running");

  if (!hasPendingWork && !hasRunningWork) {
    const lastActive = lastActivity.get(account.id) || 0;
    const idleMinutes = (Date.now() - lastActive) / 60_000;
    if (idleMinutes > config.idle_timeout_min) {
      return 0;
    }
  }

  if (!hasPendingWork && !hasRunningWork) return 0;

  const serverUrl = process.env.ALCHEMY_SERVER_URL || `http://localhost:${process.env.PORT || 3001}`;

  let submitted = 0;
  for (let i = 0; i < pendingDeficit; i++) {
    const jobId = await submitSlurmJob(account, serverUrl);
    if (jobId) {
      submitted++;
      webNs.emit("autoqueue.submitted", {
        account_id: account.id,
        account_name: account.name,
        job_id: jobId,
        state: { online: onlineStubs, pending: pendingJobs + submitted, target_running: targetRunning, target_pending: targetPending },
      });
    }
  }

  if (submitted > 0) {
    console.log(`[autoqueue] ${account.name}: submitted ${submitted} jobs (online=${onlineStubs}, pending=${pendingJobs}→${pendingJobs + submitted}, target: ${targetRunning}R/${targetPending}P)`);
  }
  return submitted;
}

export function startAutoQueueLoop(webNs: Namespace): void {
  // Check every 60s
  setInterval(async () => {
    try {
      for (const config of store.getAllAutoQueueConfigs()) {
        await checkAutoQueue(config, webNs);
      }
    } catch (err) {
      console.error("[autoqueue] Loop error:", err);
    }
  }, 60_000);

  console.log("[autoqueue] Auto-queue loop started");
}

// Export for manual trigger
export async function triggerAutoQueue(accountId: string, webNs: Namespace): Promise<{ submitted: number }> {
  const configs = store.getAllAutoQueueConfigs().filter((c) => c.account_id === accountId);
  let submitted = 0;
  for (const config of configs) {
    submitted += await checkAutoQueue({ ...config, enabled: true }, webNs);
  }
  return { submitted };
}
