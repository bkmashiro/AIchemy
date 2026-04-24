import { useState } from "react";
import { saveToken } from "../lib/api";

export default function LoginPage({ onAuth }: { onAuth: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!token.trim()) return;
    setLoading(true);
    setError("");
    try {
      const r = await fetch("/api/tasks", {
        headers: { Authorization: `Bearer ${token.trim()}` },
      });
      if (r.ok) {
        saveToken(token.trim());
        onAuth();
      } else {
        setError("Invalid token");
      }
    } catch {
      setError("Cannot reach server");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-8 w-full max-w-sm">
        <div className="flex items-center gap-2 mb-6">
          <span className="text-2xl">&#9878;&#65039;</span>
          <span className="font-bold text-white text-xl">Alchemy</span>
          <span className="text-gray-600 text-xs">v2.1</span>
        </div>
        <label className="block text-sm text-gray-400 mb-2">API Token</label>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="alchemy-v2-token"
          className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 mb-3"
          autoFocus
        />
        {error && <p className="text-red-400 text-xs mb-3">{error}</p>}
        <button
          onClick={submit}
          disabled={loading}
          className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 text-white text-sm font-medium rounded px-3 py-2 transition-colors"
        >
          {loading ? "..." : "Connect"}
        </button>
      </div>
    </div>
  );
}
