import { Task } from "./types";

export function shellQuote(value: string): string {
  if (value === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function shellQuoteAlways(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function scriptArgv(script: string): string[] {
  if (script.endsWith(".py") && !script.startsWith("python")) return ["python", script];
  return [script];
}

export function buildCommandArgv(task: Partial<Task>): string[] | undefined {
  const script = task.script || "";
  if (!script || /\s/.test(script) || task.raw_args || task.env_setup) return undefined;
  if (typeof task.args === "string") return undefined;
  const argv = scriptArgv(script);
  if (Array.isArray(task.argv)) argv.push(...task.argv.map(String));
  if (Array.isArray(task.args)) argv.push(...task.args.map(String));
  else if (task.args && Object.keys(task.args).length > 0) {
    for (const [k, v] of Object.entries(task.args)) argv.push(k, String(v));
  }
  return argv;
}

export function assembleCommand(task: Partial<Task>): string {
  const parts: string[] = [];
  const envSetup = task.env_setup;
  const cwd = task.cwd;
  const env = task.env;
  const script = task.script || "";
  const args = task.args;
  const rawArgs = task.raw_args;

  if (envSetup) parts.push(`${envSetup} &&`);
  if (cwd) parts.push(`cd ${shellQuoteAlways(cwd)} &&`);
  if (env && Object.keys(env).length > 0) {
    const envStr = Object.entries(env)
      .filter(([k]) => !k.startsWith("ALCHEMY_"))
      .map(([k, v]) => `export ${k}=${shellQuoteAlways(String(v))}`)
      .join(" && ");
    if (envStr) parts.push(`${envStr} &&`);
  }

  const commandArgv = buildCommandArgv(task);
  if (commandArgv) {
    parts.push(commandArgv.map(shellQuote).join(" "));
  } else if (script.endsWith(".py") && !script.startsWith("python")) {
    parts.push(`python ${shellQuote(script)}`);
  } else {
    parts.push(script);
  }

  if (!commandArgv && args) {
    if (typeof args === "string") {
      const trimmed = args.trim();
      if (trimmed) parts.push(trimmed);
    } else if (Array.isArray(args)) {
      const argsStr = args.map((v) => shellQuote(String(v))).join(" ");
      if (argsStr) parts.push(argsStr);
    } else if (Object.keys(args).length > 0) {
      const argsStr = Object.entries(args)
        .map(([k, v]) => `${k} ${shellQuote(String(v))}`)
        .join(" ");
      parts.push(argsStr);
    }
  }
  if (rawArgs) parts.push(rawArgs);
  return parts.join(" ").trim();
}
