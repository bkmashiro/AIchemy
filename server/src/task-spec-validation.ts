export interface TaskExecutionSpecInput {
  requirements?: unknown;
  python_env?: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateTaskExecutionSpec(input: TaskExecutionSpecInput): string | undefined {
  if (input.requirements !== undefined) {
    if (!isPlainObject(input.requirements)) return "requirements must be an object";
    const gpuType = input.requirements.gpu_type;
    if (gpuType !== undefined) {
      if (!Array.isArray(gpuType)) return "requirements.gpu_type must be an array of non-empty strings";
      if (gpuType.some((value) => typeof value !== "string" || value.trim().length === 0)) {
        return "requirements.gpu_type must be an array of non-empty strings";
      }
    }
  }

  if (input.python_env !== undefined) {
    if (typeof input.python_env !== "string" || input.python_env.trim().length === 0
      || input.python_env.trim() !== input.python_env
      || input.python_env.includes("/") || input.python_env.includes("\\")) {
      return "python_env must be a registered environment name, not a filesystem or interpreter path";
    }
  }

  return undefined;
}
