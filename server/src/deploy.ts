/**
 * deploy.ts — Stub deployment: load config, rsync code, start.
 *
 * Deploy sequence (3 steps):
 *   1. Sync stub package to remote_dir (rsync or tar+scp via jump host)
 *   2. pkill old alchemy_stub process (ignore errors)
 *   3. nohup PYTHONPATH={remote_dir}/stub {python_path} -m alchemy_stub ...
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
  return target.user ? `${target.user}@${target.host}` : target.host;
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
    const extractCmd = `ssh ${flags} ${userAtHost(target)} "tar xzf - -C ${target.remote_dir}"`;
    await execAsync(`${tarLocal} | ${extractCmd}`, { timeout: 120_000, shell: "/bin/bash" });
  } else {
    // Direct rsync
    const sshOpts = `-o StrictHostKeyChecking=no -o ConnectTimeout=10${sshKeyPath ? ` -i ${sshKeyPath}` : ""}`;
    const rsyncCmd = `rsync -az --delete -e "ssh ${sshOpts}" "${stubLocalPath}/" "${userAtHost(target)}:${target.remote_dir}/"`;
    await execAsync(rsyncCmd, { timeout: 120_000 });
  }
}

/** Steps 2+3: kill old stub, start new one via PYTHONPATH. Returns PID. */
async function startStub(
  target: StubTarget,
  serverUrl: string,
  token: string,
  sshKeyPath?: string,
): Promise<number | undefined> {
  const { host, user, jump_host, python_path, remote_dir, max_concurrent, tags, default_cwd } = target;
  const opts = { keyPath: sshKeyPath, jumpHost: jump_host, timeout: 30_000 };

  // Step 2: kill old stub (best-effort)
  try {
    await sshExec(host, user, `pkill -f "alchemy_stub.*--server" || true`, opts);
  } catch {
    // intentionally ignored
  }

  // Step 3: launch with PYTHONPATH set so no pip install needed
  let launchCmd =
    `PYTHONPATH=${remote_dir}/stub` +
    ` nohup ${python_path} -m alchemy_stub` +
    ` --server ${JSON.stringify(serverUrl)}` +
    ` --token ${JSON.stringify(token)}` +
    ` --max-concurrent ${max_concurrent}`;
  if (tags) launchCmd += ` --tags ${JSON.stringify(tags)}`;
  if (default_cwd) launchCmd += ` --default-cwd ${JSON.stringify(default_cwd)}`;
  launchCmd += ` >> ${remote_dir}/stub.log 2>&1 & echo $!`;

  const pidStr = await sshExec(host, user, launchCmd, opts);
  const pid = parseInt(pidStr.trim(), 10);
  return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function deployStub(
  target: StubTarget,
  serverUrl: string,
  token: string,
  sshKeyPath?: string,
  stubLocalPath?: string,
): Promise<DeployResult> {
  const localPath = stubLocalPath ?? DEFAULT_STUB_LOCAL_PATH;
  logger.info("deploy.start", { target: target.name, host: target.host });

  // Step 1: sync code
  try {
    await syncCode(target, localPath, sshKeyPath);
    logger.info("deploy.synced", { target: target.name });
  } catch (err) {
    logger.error("deploy.sync_failed", { target: target.name, error: String(err) });
    return { ok: false, target: target.name, step: "sync", error: String(err) };
  }

  // Steps 2+3: kill + start
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
): Promise<{ running: boolean; pid?: number }> {
  try {
    const out = await sshExec(
      target.host,
      target.user,
      `pgrep -f "alchemy_stub.*--server" || true`,
      { keyPath: sshKeyPath, jumpHost: target.jump_host, timeout: 15_000 },
    );
    const pid = parseInt(out.trim().split("\n")[0], 10);
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
): Promise<DeployResult> {
  logger.info("deploy.restart", { target: target.name, host: target.host });
  try {
    const pid = await startStub(target, serverUrl, token, sshKeyPath);
    logger.info("deploy.restarted", { target: target.name, pid });
    return { ok: true, target: target.name, pid };
  } catch (err) {
    logger.error("deploy.restart_failed", { target: target.name, error: String(err) });
    return { ok: false, target: target.name, step: "start", error: String(err) };
  }
}
