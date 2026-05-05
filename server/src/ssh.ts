/**
 * ssh.ts — SSH utilities for remote command execution.
 */

import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export function buildSshCmd(opts: {
  host: string;
  user?: string;
  keyPath?: string;
  jumpHost?: string;
  command: string;
}): string {
  const { host, user, keyPath, jumpHost, command } = opts;
  const userPrefix = user ? `${user}@` : "";
  const keyFlag = keyPath ? `-i ${keyPath}` : "";
  const jumpFlag = jumpHost ? `-J ${jumpHost}` : "";
  const flags = [keyFlag, jumpFlag, "-o StrictHostKeyChecking=no", "-o ConnectTimeout=10"]
    .filter(Boolean)
    .join(" ");
  return `ssh ${flags} ${userPrefix}${host} ${JSON.stringify(command)}`;
}

export async function sshExec(
  host: string,
  user: string | undefined,
  command: string,
  opts?: { keyPath?: string; jumpHost?: string; timeout?: number }
): Promise<string> {
  const sshCmd = buildSshCmd({
    host,
    user,
    keyPath: opts?.keyPath,
    jumpHost: opts?.jumpHost,
    command,
  });
  const { stdout } = await execAsync(sshCmd, { timeout: opts?.timeout ?? 30_000 });
  return stdout.trim();
}
