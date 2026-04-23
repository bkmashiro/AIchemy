import { useState } from "react";
import { Stub, tasksApi } from "../lib/api";

interface Props {
  stubId?: string;
  stubs?: Stub[];
  onSubmit?: () => void;
  onClose: () => void;
}

export default function TaskForm({ stubId: initialStubId, stubs = [], onSubmit, onClose }: Props) {
  const [targetStubId, setTargetStubId] = useState(initialStubId || "");
  const [command, setCommand] = useState("");
  const [cwd, setCwd] = useState("");
  const [envSetup, setEnvSetup] = useState("");
  const [envVars, setEnvVars] = useState("");
  const [maxRetries, setMaxRetries] = useState(0);
  const [estimatedVram, setEstimatedVram] = useState("");
  const [runDir, setRunDir] = useState("");
  const [resumable, setResumable] = useState(false);
  const [dependsOn, setDependsOn] = useState("");
  const [force, setForce] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const isGlobal = !targetStubId;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!command.trim()) {
      setError("Command is required");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const env: Record<string, string> = {};
      for (const line of envVars.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const idx = trimmed.indexOf("=");
        if (idx < 0) continue;
        env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
      }

      const depends_on = dependsOn.trim()
        ? dependsOn.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
        : undefined;

      const payload = {
        command: command.trim(),
        cwd: cwd.trim() || undefined,
        env: Object.keys(env).length > 0 ? env : undefined,
        env_setup: envSetup.trim() || undefined,
        max_retries: maxRetries > 0 ? maxRetries : undefined,
        estimated_vram_mb: estimatedVram ? parseInt(estimatedVram) : undefined,
        run_dir: runDir.trim() || undefined,
        resumable: resumable || undefined,
        depends_on,
        force: force || undefined,
      };

      if (isGlobal) {
        await tasksApi.submitGlobal(payload);
      } else {
        await tasksApi.submit(targetStubId, payload);
      }
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
      <div className="bg-gray-900 rounded-2xl w-full max-w-xl border border-gray-700 shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-gray-900 border-b border-gray-800 px-6 py-4 flex items-center justify-between rounded-t-2xl">
          <h2 className="text-base font-semibold text-white">Submit Task</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-lg transition-colors">✕</button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {/* Target stub selector */}
          <div>
            <label className="text-xs text-gray-400 block mb-1.5 font-medium">Target</label>
            <select
              value={targetStubId}
              onChange={(e) => setTargetStubId(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
            >
              <option value="">Global Queue (auto-dispatch)</option>
              {stubs.filter((s) => s.status === "online").map((s) => (
                <option key={s.id} value={s.id}>{s.name} — {s.gpu.name}</option>
              ))}
            </select>
          </div>

          {/* Command */}
          <div>
            <label className="text-xs text-gray-400 block mb-1.5 font-medium">Command *</label>
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="python train.py --config cfg.yaml"
              autoFocus
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-blue-500 placeholder-gray-600"
            />
          </div>

          {/* CWD + Run dir */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-400 block mb-1.5 font-medium">Working Directory</label>
              <input
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="/path/to/project"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-blue-500 placeholder-gray-600"
              />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1.5 font-medium">Run Dir</label>
              <input
                value={runDir}
                onChange={(e) => setRunDir(e.target.value)}
                placeholder="/runs/experiment-1"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-blue-500 placeholder-gray-600"
              />
            </div>
          </div>

          {/* Env setup */}
          <div>
            <label className="text-xs text-gray-400 block mb-1.5 font-medium">Env Setup</label>
            <textarea
              value={envSetup}
              onChange={(e) => setEnvSetup(e.target.value)}
              rows={2}
              placeholder="source activate myenv"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-blue-500 placeholder-gray-600 resize-none"
            />
          </div>

          {/* Env vars */}
          <div>
            <label className="text-xs text-gray-400 block mb-1.5 font-medium">Environment Variables (KEY=VALUE per line)</label>
            <textarea
              value={envVars}
              onChange={(e) => setEnvVars(e.target.value)}
              rows={3}
              placeholder={"CUDA_VISIBLE_DEVICES=0\nWANDB_MODE=offline"}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-blue-500 placeholder-gray-600 resize-none"
            />
          </div>

          {/* Deps */}
          <div>
            <label className="text-xs text-gray-400 block mb-1.5 font-medium">Depends On (task IDs, comma or newline separated)</label>
            <textarea
              value={dependsOn}
              onChange={(e) => setDependsOn(e.target.value)}
              rows={2}
              placeholder="uuid1, uuid2"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-blue-500 placeholder-gray-600 resize-none"
            />
          </div>

          {/* Numeric options */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-400 block mb-1.5 font-medium">Max Retries</label>
              <input
                type="number"
                min={0}
                value={maxRetries}
                onChange={(e) => setMaxRetries(parseInt(e.target.value) || 0)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1.5 font-medium">Est. VRAM (MB)</label>
              <input
                type="number"
                min={0}
                value={estimatedVram}
                onChange={(e) => setEstimatedVram(e.target.value)}
                placeholder="e.g. 8000"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 placeholder-gray-600"
              />
            </div>
          </div>

          {/* Checkboxes */}
          <div className="flex gap-6">
            <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={resumable}
                onChange={(e) => setResumable(e.target.checked)}
                className="accent-blue-500"
              />
              Resumable
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={force}
                onChange={(e) => setForce(e.target.checked)}
                className="accent-blue-500"
              />
              Force (skip run_dir conflict check)
            </label>
          </div>

          {error && (
            <div className="bg-red-900/30 border border-red-800/50 rounded-lg px-3 py-2 text-sm text-red-300">
              {error}
            </div>
          )}

          <div className="flex gap-3 justify-end pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-5 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg disabled:opacity-50 transition-colors font-medium"
            >
              {loading ? "Submitting..." : isGlobal ? "Submit to Global Queue" : "Submit to Stub"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
