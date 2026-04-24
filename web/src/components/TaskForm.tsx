import { useState } from "react";
import { Stub, tasksApi, stubsApi, TaskSubmitPayload } from "../lib/api";
import { generateDisplayName } from "../lib/format";

interface ArgRow {
  key: string;
  value: string;
}

interface EnvRow {
  key: string;
  value: string;
}

interface Props {
  stubs?: Stub[];
  defaultStubId?: string;
  onSubmit?: () => void;
  onClose: () => void;
}

function IdempotencyKey(): string {
  return crypto.randomUUID();
}

export default function TaskForm({ stubs = [], defaultStubId, onSubmit, onClose }: Props) {
  const [script, setScript] = useState("");
  const [args, setArgs] = useState<ArgRow[]>([{ key: "", value: "" }]);
  const [rawArgs, setRawArgs] = useState("");
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("");
  const [envSetup, setEnvSetup] = useState("");
  const [envVars, setEnvVars] = useState<EnvRow[]>([]);
  const [gpuMemMb, setGpuMemMb] = useState("");
  const [cpuMemMb, setCpuMemMb] = useState("");
  const [gpuType, setGpuType] = useState("");
  const [targetTags, setTargetTags] = useState("");
  const [priority, setPriority] = useState("5");
  const [maxRetries, setMaxRetries] = useState("0");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [targetStubId, setTargetStubId] = useState(defaultStubId || "");

  const onlineStubs = stubs.filter((s) => s.status === "online");

  // Add/remove arg rows
  const addArg = () => setArgs((prev) => [...prev, { key: "", value: "" }]);
  const removeArg = (i: number) => setArgs((prev) => prev.filter((_, idx) => idx !== i));
  const updateArg = (i: number, field: "key" | "value", val: string) =>
    setArgs((prev) => prev.map((row, idx) => (idx === i ? { ...row, [field]: val } : row)));

  // Add/remove env var rows
  const addEnvVar = () => setEnvVars((prev) => [...prev, { key: "", value: "" }]);
  const removeEnvVar = (i: number) => setEnvVars((prev) => prev.filter((_, idx) => idx !== i));
  const updateEnvVar = (i: number, field: "key" | "value", val: string) =>
    setEnvVars((prev) => prev.map((row, idx) => (idx === i ? { ...row, [field]: val } : row)));

  // Live preview of display_name
  const preview = generateDisplayName({
    name: name.trim() || undefined,
    script: script.trim() || undefined,
    args: Object.fromEntries(
      args.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value.trim()])
    ),
  });

  const buildPayload = (): TaskSubmitPayload => {
    const argsMap: Record<string, string> = {};
    for (const row of args) {
      if (row.key.trim()) argsMap[row.key.trim()] = row.value.trim();
    }

    const requirements: TaskSubmitPayload["requirements"] = {};
    if (gpuMemMb.trim()) requirements.gpu_mem_mb = parseInt(gpuMemMb);
    if (cpuMemMb.trim()) requirements.cpu_mem_mb = parseInt(cpuMemMb);
    if (gpuType.trim()) requirements.gpu_type = gpuType.split(",").map((s) => s.trim()).filter(Boolean);

    const envMap: Record<string, string> = {};
    for (const row of envVars) {
      if (row.key.trim()) envMap[row.key.trim()] = row.value.trim();
    }

    const tags = targetTags.split(",").map((s) => s.trim()).filter(Boolean);

    return {
      script: script.trim(),
      args: Object.keys(argsMap).length > 0 ? argsMap : undefined,
      raw_args: rawArgs.trim() || undefined,
      name: name.trim() || undefined,
      cwd: cwd.trim() || undefined,
      env_setup: envSetup.trim() || undefined,
      env: Object.keys(envMap).length > 0 ? envMap : undefined,
      requirements: Object.keys(requirements).length > 0 ? requirements : undefined,
      priority: parseInt(priority) || 5,
      target_tags: tags.length > 0 ? tags : undefined,
      max_retries: parseInt(maxRetries) || 0,
      idempotency_key: IdempotencyKey(),
    };
  };

  const validate = (): string | null => {
    if (!script.trim()) return "Script is required";
    const p = parseInt(priority);
    if (isNaN(p) || p < 1 || p > 10) return "Priority must be 1–10";
    if (gpuMemMb.trim() && isNaN(parseInt(gpuMemMb))) return "GPU mem must be a number";
    return null;
  };

  const handleSubmitGlobal = async (e: React.MouseEvent) => {
    e.preventDefault();
    const err = validate();
    if (err) { setError(err); return; }
    setLoading(true);
    setError("");
    try {
      await tasksApi.submit(buildPayload());
      onSubmit?.();
      onClose();
    } catch (err: any) {
      setError(err.response?.data?.error || "Failed to submit task");
    } finally {
      setLoading(false);
    }
  };

  const handleSubmitToStub = async (stubId: string) => {
    const err = validate();
    if (err) { setError(err); return; }
    setLoading(true);
    setError("");
    try {
      await stubsApi.submitTask(stubId, buildPayload());
      onSubmit?.();
      onClose();
    } catch (err: any) {
      setError(err.response?.data?.error || "Failed to submit task");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 rounded-2xl w-full max-w-2xl border border-gray-700 shadow-2xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-gray-900 border-b border-gray-800 px-6 py-4 flex items-center justify-between rounded-t-2xl">
          <div>
            <h2 className="text-base font-semibold text-white">Submit Task</h2>
            {script.trim() && (
              <p className="text-xs text-gray-500 mt-0.5">
                Preview: <span className="text-gray-300">{preview}</span>
              </p>
            )}
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-lg transition-colors">
            ✕
          </button>
        </div>

        <div className="p-6 space-y-5">
          {/* Script */}
          <div>
            <label className="text-xs text-gray-400 block mb-1.5 font-medium">
              Script <span className="text-red-400">*</span>
            </label>
            <input
              value={script}
              onChange={(e) => setScript(e.target.value)}
              placeholder="python train_atari.py"
              autoFocus
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-blue-500 placeholder-gray-600"
            />
          </div>

          {/* Args */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs text-gray-400 font-medium">Args</label>
              <button
                type="button"
                onClick={addArg}
                className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
              >
                + Add arg
              </button>
            </div>
            <div className="space-y-1.5">
              {args.map((row, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input
                    value={row.key}
                    onChange={(e) => updateArg(i, "key", e.target.value)}
                    placeholder="--config"
                    className="w-36 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm font-mono text-white focus:outline-none focus:border-blue-500 placeholder-gray-600"
                  />
                  <span className="text-gray-600 text-sm">=</span>
                  <input
                    value={row.value}
                    onChange={(e) => updateArg(i, "value", e.target.value)}
                    placeholder="configs/atari_ctx512.yaml"
                    className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm font-mono text-white focus:outline-none focus:border-blue-500 placeholder-gray-600"
                  />
                  {args.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeArg(i)}
                      className="text-gray-600 hover:text-red-400 text-sm transition-colors px-1"
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="mt-2">
              <input
                value={rawArgs}
                onChange={(e) => setRawArgs(e.target.value)}
                placeholder="extra flags: --verbose --debug (optional)"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm font-mono text-white focus:outline-none focus:border-blue-500 placeholder-gray-600"
              />
            </div>
          </div>

          {/* Name + cwd */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-400 block mb-1.5 font-medium">
                Name <span className="text-gray-600">(optional)</span>
              </label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="atari_ctx512_s42"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 placeholder-gray-600"
              />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1.5 font-medium">
                cwd <span className="text-gray-600">(inherit from stub)</span>
              </label>
              <input
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="/path/to/project"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-blue-500 placeholder-gray-600"
              />
            </div>
          </div>

          {/* Requirements: GPU mem + CPU mem + GPU type */}
          <div>
            <label className="text-xs text-gray-400 block mb-1.5 font-medium">Requirements</label>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-xs text-gray-600 block mb-1">GPU mem (MB)</label>
                <input
                  type="number"
                  min={0}
                  value={gpuMemMb}
                  onChange={(e) => setGpuMemMb(e.target.value)}
                  placeholder="e.g. 15000"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 placeholder-gray-600"
                />
              </div>
              <div>
                <label className="text-xs text-gray-600 block mb-1">CPU mem (MB)</label>
                <input
                  type="number"
                  min={0}
                  value={cpuMemMb}
                  onChange={(e) => setCpuMemMb(e.target.value)}
                  placeholder="e.g. 60000"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 placeholder-gray-600"
                />
              </div>
              <div>
                <label className="text-xs text-gray-600 block mb-1">GPU type</label>
                <input
                  value={gpuType}
                  onChange={(e) => setGpuType(e.target.value)}
                  placeholder="A40, A30"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-blue-500 placeholder-gray-600"
                />
              </div>
            </div>
          </div>

          {/* Target tags */}
          <div>
            <label className="text-xs text-gray-400 block mb-1.5 font-medium">
              Target tags <span className="text-gray-600">(optional, comma-separated)</span>
            </label>
            <input
              value={targetTags}
              onChange={(e) => setTargetTags(e.target.value)}
              placeholder="a40-cluster, ys25"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-blue-500 placeholder-gray-600"
            />
          </div>

          {/* Priority + retries */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-400 block mb-1.5 font-medium">
                Priority <span className="text-gray-600">(1–10, default 5)</span>
              </label>
              <input
                type="number"
                min={1}
                max={10}
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1.5 font-medium">Max retries</label>
              <input
                type="number"
                min={0}
                value={maxRetries}
                onChange={(e) => setMaxRetries(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>

          {/* env_setup */}
          <div>
            <label className="text-xs text-gray-400 block mb-1.5 font-medium">
              env_setup <span className="text-gray-600">(shell commands, optional)</span>
            </label>
            <input
              value={envSetup}
              onChange={(e) => setEnvSetup(e.target.value)}
              placeholder='export PATH=/vol/.../bin:$PATH'
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-blue-500 placeholder-gray-600"
            />
          </div>

          {/* Env vars */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs text-gray-400 font-medium">Env vars</label>
              <button
                type="button"
                onClick={addEnvVar}
                className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
              >
                + Add var
              </button>
            </div>
            {envVars.length > 0 && (
              <div className="space-y-1.5">
                {envVars.map((row, i) => (
                  <div key={i} className="flex gap-2 items-center">
                    <input
                      value={row.key}
                      onChange={(e) => updateEnvVar(i, "key", e.target.value)}
                      placeholder="MY_VAR"
                      className="w-32 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm font-mono text-white focus:outline-none focus:border-blue-500 placeholder-gray-600"
                    />
                    <span className="text-gray-600 text-sm">=</span>
                    <input
                      value={row.value}
                      onChange={(e) => updateEnvVar(i, "value", e.target.value)}
                      placeholder="value"
                      className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm font-mono text-white focus:outline-none focus:border-blue-500 placeholder-gray-600"
                    />
                    <button
                      type="button"
                      onClick={() => removeEnvVar(i)}
                      className="text-gray-600 hover:text-red-400 text-sm transition-colors px-1"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {error && (
            <div className="bg-red-900/30 border border-red-800/50 rounded-lg px-3 py-2 text-sm text-red-300">
              {error}
            </div>
          )}

          {/* Submit buttons */}
          <div className="flex gap-3 justify-end pt-2 flex-wrap">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
            >
              Cancel
            </button>

            {/* Submit to specific stub dropdown */}
            {onlineStubs.length > 0 && (
              <div className="flex items-stretch">
                <select
                  value={targetStubId}
                  onChange={(e) => setTargetStubId(e.target.value)}
                  className="bg-gray-800 border border-gray-700 border-r-0 rounded-l-lg px-2 py-2 text-sm text-gray-300 focus:outline-none focus:border-blue-500 max-w-[160px]"
                >
                  <option value="">— pick stub —</option>
                  {onlineStubs.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={loading || !targetStubId}
                  onClick={() => targetStubId && handleSubmitToStub(targetStubId)}
                  className="px-4 py-2 text-sm bg-gray-700 hover:bg-gray-600 border border-gray-700 rounded-r-lg text-white disabled:opacity-40 transition-colors font-medium whitespace-nowrap"
                >
                  Submit to Stub
                </button>
              </div>
            )}

            <button
              type="button"
              disabled={loading}
              onClick={handleSubmitGlobal}
              className="px-5 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg disabled:opacity-50 transition-colors font-medium"
            >
              {loading ? "Submitting..." : "Submit to Queue"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
