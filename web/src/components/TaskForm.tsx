import { useState } from "react";
import { tasksApi } from "../lib/api";

interface Props {
  stubId: string;
  onSubmit?: () => void;
  onClose: () => void;
}

export default function TaskForm({ stubId, onSubmit, onClose }: Props) {
  const [command, setCommand] = useState("");
  const [cwd, setCwd] = useState("");
  const [envSetup, setEnvSetup] = useState("");
  const [envVars, setEnvVars] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!command.trim()) {
      setError("Command is required");
      return;
    }
    setLoading(true);
    setError("");
    try {
      // Parse env vars: KEY=VALUE per line
      const env: Record<string, string> = {};
      for (const line of envVars.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const idx = trimmed.indexOf("=");
        if (idx < 0) continue;
        env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
      }
      await tasksApi.submit(stubId, {
        command: command.trim(),
        cwd: cwd.trim() || undefined,
        env: Object.keys(env).length > 0 ? env : undefined,
        env_setup: envSetup.trim() || undefined,
      });
      onSubmit?.();
      onClose();
    } catch (err: any) {
      setError(err.response?.data?.error || "Failed to submit task");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-gray-900 rounded-xl p-6 w-full max-w-lg border border-gray-700 shadow-2xl">
        <h2 className="text-lg font-semibold text-white mb-4">Submit New Task</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-sm text-gray-400 block mb-1">Command *</label>
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="python train.py --config cfg.yaml"
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="text-sm text-gray-400 block mb-1">Working Directory</label>
            <input
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="/path/to/project"
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="text-sm text-gray-400 block mb-1">Env Setup (shell commands)</label>
            <textarea
              value={envSetup}
              onChange={(e) => setEnvSetup(e.target.value)}
              rows={2}
              placeholder="source activate myenv"
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="text-sm text-gray-400 block mb-1">Env Variables (KEY=VALUE per line)</label>
            <textarea
              value={envVars}
              onChange={(e) => setEnvVars(e.target.value)}
              rows={3}
              placeholder={"CUDA_VISIBLE_DEVICES=0\nWANDB_MODE=offline"}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-blue-500"
            />
          </div>
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <div className="flex gap-3 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-400 hover:text-white transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50"
            >
              {loading ? "Submitting..." : "Submit Task"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
