import { TaskSpec } from "./types";

export interface SubmissionLintIssue {
  code: string;
  severity: "warning" | "error";
  message: string;
  ref?: string;
  field?: string;
  script?: string;
  priority?: number;
  path?: string;
  refs?: string[];
}

type TaskLike = Partial<TaskSpec> & Record<string, any> & {
  name?: string;
  target_stub_id?: string;
  target_tags?: string[];
  outputs?: string[];
  run_dir?: string;
};

const OUTPUT_FLAGS = new Set([
  "--output",
  "--out",
  "--output-path",
  "--output_path",
  "--output-dir",
  "--output_dir",
  "--result",
  "--result-path",
  "--result_path",
  "--save",
  "--save-path",
  "--save_path",
  "--logdir",
  "--log-dir",
  "--log_dir",
]);

export function lintTaskSpecs(specs: TaskLike[]): SubmissionLintIssue[] {
  const warnings: SubmissionLintIssue[] = [];
  const outputs = new Map<string, string[]>();

  specs.forEach((spec, index) => {
    const ref = String(spec.ref || spec.name || `task-${index + 1}`);
    warnings.push(...lintSingleTask(spec, ref));
    for (const output of extractOutputPaths(spec)) {
      if (!isCollisionProneRelativePath(output)) continue;
      const refs = outputs.get(output) ?? [];
      refs.push(ref);
      outputs.set(output, refs);
    }
  });

  for (const [output, refs] of [...outputs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (refs.length > 1) {
      warnings.push({
        code: "duplicate_relative_output",
        severity: "warning",
        message: `Multiple tasks write the same relative output ${JSON.stringify(output)}; make it unique per ref/seed or explicitly write under ALCHEMY_RUN_DIR`,
        path: output,
        refs,
      });
    }
  }
  return warnings;
}

export function lintSingleTask(spec: TaskLike, ref: string): SubmissionLintIssue[] {
  const warnings: SubmissionLintIssue[] = [];
  const script = String(spec.script || "");
  const hasRuntimeEnv = Boolean(spec.python_env || spec.env_setup);
  const env = { ...(spec.env || {}), ...(spec.env_overrides || {}) };
  const pythonPath = typeof env.PYTHONPATH === "string" ? env.PYTHONPATH.trim() : "";

  if (
    script.endsWith(".py") &&
    script.startsWith("/vol/bitbucket/") &&
    !hasRuntimeEnv &&
    !pythonPath
  ) {
    warnings.push({
      code: "python_script_uses_default_python",
      severity: "warning",
      message: `Task ${JSON.stringify(ref)} is a cluster .py script that will be launched with plain \`python\`; cluster default Python often lacks project deps/torch. Prefer script=<absolute python> and put the .py path in argv/raw_args, or set python_env/env_setup/PYTHONPATH.`,
      ref,
      field: "script",
      script,
    });
  }

  if (explicitHighPriority(spec) && !spec.target_stub_id && !(spec.target_tags && spec.target_tags.length > 0)) {
    warnings.push({
      code: "high_priority_unrouted",
      severity: "warning",
      message: `Task ${JSON.stringify(ref)} sets high priority without target routing; priority sorts descending, so this can jump older queue work. Lower priority or set target_stub_id/target_tags.`,
      ref,
      field: "priority",
      priority: Number(spec.priority),
    });
  }

  return warnings;
}

function explicitHighPriority(spec: TaskLike): boolean {
  if (!("priority" in spec)) return false;
  const priority = Number(spec.priority);
  return Number.isFinite(priority) && priority >= 5;
}

function extractOutputPaths(spec: TaskLike): string[] {
  const paths: string[] = [];
  if (Array.isArray(spec.outputs)) {
    for (const value of spec.outputs) {
      if (typeof value === "string" && value.trim()) paths.push(value);
    }
  }
  const args = spec.args;
  if (args && typeof args === "object" && !Array.isArray(args)) {
    for (const [key, value] of Object.entries(args)) {
      if (OUTPUT_FLAGS.has(key) && value !== undefined && value !== null) paths.push(String(value));
    }
  } else if (typeof args === "string") {
    paths.push(...extractFlagValues(args));
  }
  if (typeof spec.raw_args === "string") {
    paths.push(...extractFlagValues(spec.raw_args));
  }
  return paths;
}

function extractFlagValues(text: string): string[] {
  const tokens = tokeniseShellish(text);
  const out: string[] = [];
  tokens.forEach((token, index) => {
    if (OUTPUT_FLAGS.has(token) && index + 1 < tokens.length) {
      out.push(tokens[index + 1]);
      return;
    }
    for (const flag of OUTPUT_FLAGS) {
      const prefix = `${flag}=`;
      if (token.startsWith(prefix) && token.length > prefix.length) {
        out.push(token.slice(prefix.length));
        return;
      }
    }
  });
  return out;
}

function tokeniseShellish(text: string): string[] {
  const tokens: string[] = [];
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

function isCollisionProneRelativePath(value: string): boolean {
  if (!value || value.startsWith("/")) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return false;
  if (value.includes("$ALCHEMY_RUN_DIR") || value.includes("${ALCHEMY_RUN_DIR}")) return false;
  if (value.includes("{") || value.includes("}")) return false;
  return true;
}
