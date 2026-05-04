/**
 * deploy.ts — Stub deployment: load config, rsync code, start.
 *
 * Deploy sequence (3 steps):
 *   1. Sync stub package to remote_dir (rsync or tar+scp via jump host)
 *   2. pkill old alchemy_stub process (ignore errors)
 *   3. nohup PYTHONPATH={remote_dir}/stub {python_path} -m alchemy_stub ...
 *
 * For SLURM targets, step 3 submits an sbatch job instead.
 *
 * NOTE: requires the `yaml` package — add to package.json:
 *   "yaml": "^2.4.0"
 */

import { exec } from "child_process";
import { promisify } from "util";
import { readFileSync, existsSync } from "fs";
import { logger } from "./log";
import { DeployFileConfig, StubTarget, DeployResult } from "./types";
import { buildSshCmd, sshExec } from "./ssh";

const execAsync = promisify(exec);

// Default stub package path relative to this file (server/src → ../stub)
const DEFAULT_STUB_LOCAL_PATH = `${__dirname}/../../stub`;

// ─── Config loading ───────────────────────────────────────────────────────────

export function loadDeployConfig(filePath: string): DeployFileConfig | null {
  if (!existsSync(filePath)) {
    logger.info("deploy.config_not_found", { path: filePath });
    return null;
  }
  try {
    // Dynamic require so yaml stays an optional dep at type-check time.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const yaml = require("yaml") as { parse: (s: string) => any };
    const raw = readFileSync(filePath, "utf8");
    const parsed = yaml.parse(raw) as DeployFileConfig;
    if (!Array.isArray(parsed?.stubs)) {
      logger.warn("deploy.config_invalid", { path: filePath, reason: "stubs must be an array" });
      return null;
    }
    logger.info("deploy.config_loaded", { path: filePath, stub_count: parsed.stubs.length });
    return parsed;
  } catch (err) {
    logger.error("deploy.config_load_failed", { path: filePath, error: String(err) });
    return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function userAtHost(target: StubTarget): string {
  const host = target.host ?? "";
  return target.user ? `${target.user}@${host}` : host;
}

function slurmUserAtHost(target: StubTarget): string {
  const host = target.ssh_host ?? "";
  return target.ssh_user ? `${target.ssh_user}@${host}` : host;
}

/** Step 1: sync stub package to remote_dir. */
async function syncCode(
  target: StubTarget,
  stubLocalPath: string,
  sshKeyPath?: string,
): Promise<void> {
  if (target.jump_host) {
    // tar pipe through ProxyJump — rsync not available cross-jump
    const flags = [
      "-o StrictHostKeyChecking=no",
      "-o ConnectTimeout=10",
      ...(sshKeyPath ? [`-i ${sshKeyPath}`] : []),
      `-J ${target.jump_host}`,
    ].join(" ");
    const mkdirCmd = `ssh ${flags} ${userAtHost(target)} "mkdir -p ${target.remote_dir}"`;
    await execAsync(mkdirCmd, { timeout: 30_000 });

    const tarLocal = `tar czf - -C "${stubLocalPath}" .`;
    // Clear __pycache__ before extract to avoid stale .pyc masking new code
    const extractCmd = `ssh ${flags} ${userAtHost(target)} "find ${target.remote_dir} -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null; tar xzf - -C ${target.remote_dir}"`;
    await execAsync(`${tarLocal} | ${extractCmd}`, { timeout: 120_000, shell: "/bin/bash" });
  } else {
    // Direct rsync
    const sshOpts = `-o StrictHostKeyChecking=no -o ConnectTimeout=10${sshKeyPath ? ` -i ${sshKeyPath}` : ""}`;
    const rsyncCmd = `rsync -az --delete -e "ssh ${sshOpts}" "${stubLocalPath}/" "${userAtHost(target)}:${target.remote_dir}/"`;
    await execAsync(rsyncCmd, { timeout: 120_000 });
  }
}

/** Steps 2+3: kill old stub, start new one via PYTHONPATH. Returns PID.
 *
 * Isolation: each stub gets its own PID file (`/tmp/alchemy_stub_{name}.pid`)
 * and log file (`stub_{name}.log`). Kill uses PID file — never `pkill -f` —
 * so NFS-shared nodes don't interfere with each other.
 */
async function startStub(
  target: StubTarget,
  serverUrl: string,
  token: string,
  sshKeyPath?: string,
): Promise<number | undefined> {
  const { user, jump_host, python_path, remote_dir, max_concurrent, tags, default_cwd, name } = target;
  const host = target.host ?? "";
  const opts = { keyPath: sshKeyPath, jumpHost: jump_host, timeout: 30_000 };
  const pidFile = `/tmp/alchemy_stub_${name}.pid`;
  const logFile = `${remote_dir}/stub_${name}.log`;

  // Step 2: kill old stub via PID file (precise, no cross-node interference)
  try {
    const killCmd =
      `if [ -f ${pidFile} ]; then` +
      ` pid=$(cat ${pidFile});` +
      ` kill $pid 2>/dev/null || true;` +
      ` sleep 1;` +
      ` kill -9 $pid 2>/dev/null || true;` +
      ` rm -f ${pidFile};` +
      ` fi`;
    await sshExec(host, user, killCmd, opts);
  } catch {
    // intentionally ignored
  }

  // Step 3: launch with PYTHONPATH set so no pip install needed
  // remote_dir contains alchemy_stub/ directly (tar extracted from stub/)
  let launchCmd =
    `PYTHONPATH=${remote_dir}` +
    ` nohup ${python_path} -m alchemy_stub` +
    ` --server ${JSON.stringify(serverUrl)}` +
    ` --token ${JSON.stringify(token)}` +
    ` --max-concurrent ${max_concurrent}`;
  if (tags) launchCmd += ` --tags ${JSON.stringify(tags)}`;
  if (default_cwd) launchCmd += ` --default-cwd ${JSON.stringify(default_cwd)}`;
  // Write PID file for clean shutdown; log to per-stub file
  launchCmd += ` >> ${logFile} 2>&1 & echo $! | tee ${pidFile}`;

  const pidStr = await sshExec(host, user, launchCmd, opts);
  const pid = parseInt(pidStr.trim(), 10);
  return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

// ─── SLURM helpers ───────────────────────────────────────────────────────────

/** Sync code to SLURM submit host (ssh_host acts as the target). */
async function syncCodeSlurm(
  target: StubTarget,
  stubLocalPath: string,
  sshKeyPath?: string,
): Promise<void> {
  const sshHost = target.ssh_host ?? "";
  const sshUser = target.ssh_user;
  const flags = [
    "-o StrictHostKeyChecking=no",
    "-o ConnectTimeout=10",
    ...(sshKeyPath ? [`-i ${sshKeyPath}`] : []),
  ].join(" ");
  const userAtH = sshUser ? `${sshUser}@${sshHost}` : sshHost;

  const mkdirCmd = `ssh ${flags} ${userAtH} "mkdir -p ${target.remote_dir}"`;
  await execAsync(mkdirCmd, { timeout: 30_000 });

  const tarLocal = `tar czf - -C "${stubLocalPath}" .`;
  const extractCmd = `ssh ${flags} ${userAtH} "find ${target.remote_dir} -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null; tar xzf - -C ${target.remote_dir}"`;
  await execAsync(`${tarLocal} | ${extractCmd}`, { timeout: 120_000, shell: "/bin/bash" });
}

interface SlurmSubmitOptions {
  mem?: string;
  time?: string;
}

/** Submit sbatch job for a SLURM target. Returns job ID. */
async function submitSlurmJob(
  target: StubTarget,
  serverUrl: string,
  token: string,
  sshKeyPath?: string,
  overrides?: SlurmSubmitOptions,
): Promise<string> {
  const sshHost = target.ssh_host ?? "";
  const sshUser = target.ssh_user;
  const jobName = `train_stub_${target.name}`;
  const mem = overrides?.mem ?? target.mem ?? "60G";
  const time = overrides?.time ?? target.time ?? "24:00:00";

  const script = [
    "#!/bin/bash",
    `#SBATCH --job-name=${jobName}`,
    `#SBATCH --partition=${target.partition ?? "gpgpu"}`,
    ...(target.gres ? [`#SBATCH --gres=${target.gres}`] : []),
    `#SBATCH --mem=${mem}`,
    `#SBATCH --time=${time}`,
    ...(target.qos ? [`#SBATCH --qos=${target.qos}`] : []),
    "#SBATCH --output=/dev/null",
    "#SBATCH --error=/dev/null",
    "",
    `PYTHONPATH=${target.remote_dir} ${target.python_path} -m alchemy_stub \\`,
    `  --server ${JSON.stringify(serverUrl)} \\`,
    `  --token ${JSON.stringify(token)} \\`,
    `  --max-concurrent ${target.max_concurrent}` +
      (target.tags ? ` \\\n  --tags ${JSON.stringify(target.tags)}` : "") +
      (target.default_cwd ? ` \\\n  --default-cwd ${JSON.stringify(target.default_cwd)}` : ""),
  ].join("\n");

  const flags = [
    "-o StrictHostKeyChecking=no",
    "-o ConnectTimeout=10",
    ...(sshKeyPath ? [`-i ${sshKeyPath}`] : []),
  ].join(" ");
  const userAtH = sshUser ? `${sshUser}@${sshHost}` : sshHost;

  // Pipe script to sbatch via heredoc
  const escapedScript = script.replace(/'/g, "'\\''");
  const submitCmd = `ssh ${flags} ${userAtH} 'cat <<'"'"'SBATCH_EOF'"'"' | sbatch\n${escapedScript}\nSBATCH_EOF'`;
  const { stdout } = await execAsync(submitCmd, { timeout: 30_000, shell: "/bin/bash" });
  const match = stdout.match(/Submitted batch job (\d+)/);
  if (!match) throw new Error(`Unexpected sbatch output: ${stdout.trim()}`);
  return match[1];
}

/** Check SLURM job status via squeue. */
async function getSlurmJobStatus(
  target: StubTarget,
  jobId: string,
  sshKeyPath?: string,
): Promise<{ running: boolean; job_id?: string }> {
  const sshHost = target.ssh_host ?? "";
  const sshUser = target.ssh_user;
  try {
    const out = await sshExec(
      sshHost,
      sshUser,
      `squeue -j ${jobId} -h -o "%i" 2>/dev/null || true`,
      { keyPath: sshKeyPath, timeout: 15_000 },
    );
    const running = out.trim().includes(jobId);
    return { running, job_id: running ? jobId : undefined };
  } catch (err) {
    logger.warn("deploy.slurm_status_failed", { target: target.name, error: String(err) });
    return { running: false };
  }
}

/** Cancel a SLURM job. */
async function cancelSlurmJob(
  target: StubTarget,
  jobId: string,
  sshKeyPath?: string,
): Promise<void> {
  const sshHost = target.ssh_host ?? "";
  const sshUser = target.ssh_user;
  await sshExec(sshHost, sshUser, `scancel ${jobId}`, { keyPath: sshKeyPath, timeout: 15_000 });
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function deployStub(
  target: StubTarget,
  serverUrl: string,
  token: string,
  sshKeyPath?: string,
  stubLocalPath?: string,
  slurmOverrides?: { mem?: string; time?: string },
): Promise<DeployResult> {
  const localPath = stubLocalPath ?? DEFAULT_STUB_LOCAL_PATH;
  logger.info("deploy.start", { target: target.name, type: target.type ?? "ssh" });

  if (target.type === "slurm") {
    // SLURM: sync code to ssh_host, then sbatch
    try {
      await syncCodeSlurm(target, localPath, sshKeyPath);
      logger.info("deploy.synced", { target: target.name });
    } catch (err) {
      logger.error("deploy.sync_failed", { target: target.name, error: String(err) });
      return { ok: false, target: target.name, step: "sync", error: String(err) };
    }

    let jobId: string;
    try {
      jobId = await submitSlurmJob(target, serverUrl, token, sshKeyPath, slurmOverrides);
      logger.info("deploy.slurm_submitted", { target: target.name, job_id: jobId });
    } catch (err) {
      logger.error("deploy.slurm_submit_failed", { target: target.name, error: String(err) });
      return { ok: false, target: target.name, step: "start", error: String(err) };
    }

    return { ok: true, target: target.name, job_id: jobId };
  }

  // SSH target
  try {
    await syncCode(target, localPath, sshKeyPath);
    logger.info("deploy.synced", { target: target.name });
  } catch (err) {
    logger.error("deploy.sync_failed", { target: target.name, error: String(err) });
    return { ok: false, target: target.name, step: "sync", error: String(err) };
  }

  let pid: number | undefined;
  try {
    pid = await startStub(target, serverUrl, token, sshKeyPath);
    logger.info("deploy.started", { target: target.name, pid });
  } catch (err) {
    logger.error("deploy.start_failed", { target: target.name, error: String(err) });
    return { ok: false, target: target.name, step: "start", error: String(err) };
  }

  return { ok: true, target: target.name, pid };
}

export async function getStubStatus(
  target: StubTarget,
  sshKeyPath?: string,
  jobId?: string,
): Promise<{ running: boolean; pid?: number; job_id?: string }> {
  if (target.type === "slurm") {
    if (!jobId) return { running: false };
    return getSlurmJobStatus(target, jobId, sshKeyPath);
  }

  const pidFile = `/tmp/alchemy_stub_${target.name}.pid`;
  try {
    const out = await sshExec(
      target.host ?? "",
      target.user,
      `if [ -f ${pidFile} ]; then pid=$(cat ${pidFile}); kill -0 $pid 2>/dev/null && echo $pid || echo 0; else echo 0; fi`,
      { keyPath: sshKeyPath, jumpHost: target.jump_host, timeout: 15_000 },
    );
    const pid = parseInt(out.trim(), 10);
    if (Number.isFinite(pid) && pid > 0) {
      return { running: true, pid };
    }
    return { running: false };
  } catch (err) {
    logger.warn("deploy.status_failed", { target: target.name, error: String(err) });
    return { running: false };
  }
}

export async function restartStub(
  target: StubTarget,
  serverUrl: string,
  token: string,
  sshKeyPath?: string,
  slurmOverrides?: { mem?: string; time?: string },
): Promise<DeployResult> {
  logger.info("deploy.restart", { target: target.name });

  if (target.type === "slurm") {
    // SLURM restart = submit new sbatch job
    try {
      const jobId = await submitSlurmJob(target, serverUrl, token, sshKeyPath, slurmOverrides);
      logger.info("deploy.slurm_restarted", { target: target.name, job_id: jobId });
      return { ok: true, target: target.name, job_id: jobId };
    } catch (err) {
      logger.error("deploy.slurm_restart_failed", { target: target.name, error: String(err) });
      return { ok: false, target: target.name, step: "start", error: String(err) };
    }
  }

  try {
    const pid = await startStub(target, serverUrl, token, sshKeyPath);
    logger.info("deploy.restarted", { target: target.name, pid });
    return { ok: true, target: target.name, pid };
  } catch (err) {
    logger.error("deploy.restart_failed", { target: target.name, error: String(err) });
    return { ok: false, target: target.name, step: "start", error: String(err) };
  }
}

export async function stopStub(
  target: StubTarget,
  sshKeyPath?: string,
  jobId?: string,
): Promise<DeployResult> {
  logger.info("deploy.stop", { target: target.name });

  if (target.type === "slurm") {
    if (!jobId) {
      return { ok: false, target: target.name, step: "stop", error: "No job ID provided" };
    }
    try {
      await cancelSlurmJob(target, jobId, sshKeyPath);
      logger.info("deploy.slurm_stopped", { target: target.name, job_id: jobId });
      return { ok: true, target: target.name, job_id: jobId };
    } catch (err) {
      logger.error("deploy.slurm_stop_failed", { target: target.name, error: String(err) });
      return { ok: false, target: target.name, step: "stop", error: String(err) };
    }
  }

  // SSH: kill via PID file
  const pidFile = `/tmp/alchemy_stub_${target.name}.pid`;
  const opts = { keyPath: sshKeyPath, jumpHost: target.jump_host, timeout: 30_000 };
  try {
    const killCmd =
      `if [ -f ${pidFile} ]; then` +
      ` pid=$(cat ${pidFile});` +
      ` kill $pid 2>/dev/null || true;` +
      ` sleep 1;` +
      ` kill -9 $pid 2>/dev/null || true;` +
      ` rm -f ${pidFile};` +
      ` echo "stopped $pid";` +
      ` else echo "no pid file"; fi`;
    const out = await sshExec(target.host ?? "", target.user, killCmd, opts);
    logger.info("deploy.stopped", { target: target.name, out });
    return { ok: true, target: target.name };
  } catch (err) {
    logger.error("deploy.stop_failed", { target: target.name, error: String(err) });
    return { ok: false, target: target.name, step: "stop", error: String(err) };
  }
}
