import { useState, useEffect } from "react";
import {
  Stub,
  Token,
  SlurmAccount,
  NotificationConfig,
  StallConfig,
  tokensApi,
  slurmAccountsApi,
  notificationsApi,
  configApi,
  adminApi,
  getStoredToken,
  saveToken,
} from "../lib/api";
import { formatTimeAgo } from "../lib/format";

interface Props {
  stubs: Stub[];
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <h2 className="text-sm font-semibold text-gray-300 mb-4">{title}</h2>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs text-gray-500 font-medium">{label}</label>
      {children}
    </div>
  );
}

const inputCls = "bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 w-full";

export default function SettingsPage({ stubs }: Props) {
  const [activeTab, setActiveTab] = useState<"general" | "tokens" | "slurm" | "notifications" | "stall" | "backup">("general");

  return (
    <div className="max-w-4xl space-y-5">
      <h1 className="text-lg font-bold text-white">Settings</h1>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-800 pb-0 flex-wrap">
        {(["general", "tokens", "slurm", "notifications", "stall", "backup"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm transition-colors border-b-2 -mb-px ${
              activeTab === tab
                ? "border-blue-500 text-blue-400"
                : "border-transparent text-gray-500 hover:text-gray-300"
            }`}
          >
            {tab === "stall" ? "Stall Detection" : tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {activeTab === "general" && <GeneralTab stubs={stubs} />}
      {activeTab === "tokens" && <TokensTab />}
      {activeTab === "slurm" && <SlurmTab />}
      {activeTab === "notifications" && <NotificationsTab />}
      {activeTab === "stall" && <StallTab />}
      {activeTab === "backup" && <BackupTab />}
    </div>
  );
}

function GeneralTab({ stubs }: { stubs: Stub[] }) {
  const [token, setToken] = useState(getStoredToken());
  const [saved, setSaved] = useState(false);

  const handleSaveToken = () => {
    saveToken(token);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="space-y-4">
      <Section title="API Token">
        <div className="space-y-3">
          <Field label="Current Token">
            <div className="flex gap-2">
              <input
                type="text"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                className={inputCls}
              />
              <button
                onClick={handleSaveToken}
                className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 rounded-lg text-white transition-colors shrink-0"
              >
                {saved ? "Saved ✓" : "Save"}
              </button>
            </div>
          </Field>
          <p className="text-xs text-gray-600">
            Token is stored in localStorage. Changing it will re-authenticate all API calls.
          </p>
        </div>
      </Section>

      <Section title="Connected Stubs">
        {stubs.length === 0 ? (
          <p className="text-gray-600 text-sm">No stubs registered</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-600 border-b border-gray-800">
                  <th className="pb-2 pr-4">Name</th>
                  <th className="pb-2 pr-4">Hostname</th>
                  <th className="pb-2 pr-4">GPU</th>
                  <th className="pb-2 pr-4">Status</th>
                  <th className="pb-2 pr-4">Type</th>
                  <th className="pb-2">Connected</th>
                </tr>
              </thead>
              <tbody>
                {stubs.map((s) => (
                  <tr key={s.id} className="border-b border-gray-800/50">
                    <td className="py-2 pr-4 text-white font-medium">{s.name}</td>
                    <td className="py-2 pr-4 text-gray-400 font-mono text-xs">{s.hostname}</td>
                    <td className="py-2 pr-4 text-gray-400 text-xs">{s.gpu.name} ×{s.gpu.count}</td>
                    <td className="py-2 pr-4">
                      <span className={`text-xs ${s.status === "online" ? "text-green-400" : s.status === "stale" ? "text-yellow-400" : "text-gray-500"}`}>
                        {s.status}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-gray-500 text-xs">{s.type}</td>
                    <td className="py-2 text-gray-600 text-xs">{new Date(s.connected_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}

function TokensTab() {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [loading, setLoading] = useState(true);
  const [newLabel, setNewLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const load = async () => {
    try {
      const data = await tokensApi.list();
      setTokens(data);
    } catch {}
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    setCreating(true);
    try {
      const t = await tokensApi.create(newLabel || undefined);
      setNewToken(t.token);
      setNewLabel("");
      load();
    } catch (err) {
      console.error(err);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (token: string) => {
    if (!confirm("Delete this token?")) return;
    try {
      await tokensApi.delete(token);
      setFeedback("Token deleted");
      setTimeout(() => setFeedback(null), 1500);
      load();
    } catch {}
  };

  return (
    <Section title="API Tokens">
      <div className="space-y-4">
        {newToken && (
          <div className="bg-green-900/20 border border-green-800/50 rounded-lg p-3">
            <p className="text-xs text-green-400 mb-1 font-medium">New token created — copy it now:</p>
            <p className="text-sm text-green-300 font-mono break-all">{newToken}</p>
            <button onClick={() => setNewToken(null)} className="text-xs text-gray-500 mt-2 hover:text-gray-300">Dismiss</button>
          </div>
        )}

        <div className="flex gap-2">
          <input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="Label (e.g. gpu32-stub)"
            className={`${inputCls} flex-1`}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          />
          <button
            onClick={handleCreate}
            disabled={creating}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 rounded-lg text-white transition-colors disabled:opacity-50 shrink-0"
          >
            {creating ? "Creating..." : "Create Token"}
          </button>
        </div>

        {feedback && <p className="text-xs text-green-400">{feedback}</p>}

        {loading ? (
          <p className="text-gray-600 text-sm">Loading...</p>
        ) : (
          <div className="space-y-2">
            {tokens.map((t) => (
              <div key={t.token} className="flex items-center gap-3 bg-gray-800/50 rounded-lg px-3 py-2.5">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    {t.label && <span className="text-sm text-gray-300 font-medium">{t.label}</span>}
                    {t.used_by && <span className="text-xs text-gray-600">used by {t.used_by.slice(0, 8)}</span>}
                  </div>
                  <p className="text-xs text-gray-600 font-mono mt-0.5">{t.token}</p>
                </div>
                <span className="text-xs text-gray-600">{new Date(t.created_at).toLocaleDateString()}</span>
                <button
                  onClick={() => handleDelete(t.token)}
                  className="px-2.5 py-1 text-xs bg-red-900/30 hover:bg-red-900/60 border border-red-900/50 rounded text-red-400 transition-colors"
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Section>
  );
}

function SlurmTab() {
  const [accounts, setAccounts] = useState<SlurmAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const load = async () => {
    try {
      const data = await slurmAccountsApi.list();
      setAccounts(data);
    } catch {}
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this SLURM account?")) return;
    try {
      await slurmAccountsApi.delete(id);
      setFeedback("Account deleted");
      setTimeout(() => setFeedback(null), 1500);
      load();
    } catch (err) {
      console.error(err);
    }
  };

  const handleViewUtilization = async (id: string) => {
    try {
      const data = await slurmAccountsApi.getUtilization(id);
      setFeedback(`${data.online_stubs} online, ${data.running_tasks} running`);
      setTimeout(() => setFeedback(null), 3000);
    } catch (err: any) {
      setFeedback(`Error: ${err.response?.data?.error || "Failed"}`);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-semibold text-gray-300">SLURM Accounts</h2>
        {feedback && <span className="text-xs text-green-400">{feedback}</span>}
        <button
          onClick={() => setShowForm((v) => !v)}
          className="ml-auto px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 rounded text-white transition-colors"
        >
          + Add Account
        </button>
      </div>

      {showForm && (
        <AddSlurmAccountForm
          onCreated={() => { load(); setShowForm(false); }}
          onCancel={() => setShowForm(false)}
        />
      )}

      <Section title="">
        {loading ? (
          <p className="text-gray-600 text-sm">Loading...</p>
        ) : accounts.length === 0 ? (
          <p className="text-gray-600 text-sm">No SLURM accounts configured</p>
        ) : (
          <div className="space-y-3">
            {accounts.map((acc) => (
              <div key={acc.id} className="bg-gray-800/50 rounded-xl p-4">
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <span className="text-white font-semibold">{acc.name}</span>
                    <span className="text-gray-500 text-xs ml-2">{acc.ssh_target}</span>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleViewUtilization(acc.id)}
                      className="px-2.5 py-1 text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-gray-300 transition-colors"
                    >
                      Utilization
                    </button>
                    <button
                      onClick={() => handleDelete(acc.id)}
                      className="px-2.5 py-1 text-xs bg-red-900/30 hover:bg-red-900/60 border border-red-900/50 rounded text-red-400 transition-colors"
                    >
                      Delete
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs text-gray-500">
                  <span>QOS limit: {acc.qos_limit}</span>
                  <span>Walltime: {acc.default_walltime}</span>
                  <span>Mem: {acc.default_mem}</span>
                  <span>Partitions: {acc.partitions.join(", ")}</span>
                </div>
                <p className="text-xs text-gray-600 font-mono mt-2 truncate">{acc.stub_command}</p>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function AddSlurmAccountForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [form, setForm] = useState({
    name: "",
    ssh_target: "",
    qos_limit: 5,
    partitions: "a40,a30",
    default_walltime: "24:00:00",
    default_mem: "80G",
    stub_command: "python -m alchemy_stub",
    ssh_key_path: "",
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const set = (k: string, v: any) => setForm((p) => ({ ...p, [k]: v }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name || !form.ssh_target) { setError("Name and SSH target required"); return; }
    setLoading(true);
    try {
      await slurmAccountsApi.create({
        ...form,
        partitions: form.partitions.split(",").map((s) => s.trim()).filter(Boolean),
        qos_limit: Number(form.qos_limit),
      });
      onCreated();
    } catch (err: any) {
      setError(err.response?.data?.error || "Failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-xl p-5">
      <h3 className="text-sm font-semibold text-white mb-4">Add SLURM Account</h3>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name"><input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="ys25" className={inputCls} /></Field>
          <Field label="SSH Target"><input value={form.ssh_target} onChange={(e) => set("ssh_target", e.target.value)} placeholder="ys25@gpucluster2" className={inputCls} /></Field>
          <Field label="QOS Limit"><input type="number" min={1} value={form.qos_limit} onChange={(e) => set("qos_limit", e.target.value)} className={inputCls} /></Field>
          <Field label="Partitions (comma-sep)"><input value={form.partitions} onChange={(e) => set("partitions", e.target.value)} placeholder="a40,a30,a100" className={inputCls} /></Field>
          <Field label="Default Walltime"><input value={form.default_walltime} onChange={(e) => set("default_walltime", e.target.value)} placeholder="24:00:00" className={inputCls} /></Field>
          <Field label="Default Mem"><input value={form.default_mem} onChange={(e) => set("default_mem", e.target.value)} placeholder="80G" className={inputCls} /></Field>
        </div>
        <Field label="Stub Command"><input value={form.stub_command} onChange={(e) => set("stub_command", e.target.value)} className={`${inputCls} font-mono text-xs`} /></Field>
        <Field label="SSH Key Path (optional)"><input value={form.ssh_key_path} onChange={(e) => set("ssh_key_path", e.target.value)} placeholder="~/.ssh/id_rsa" className={inputCls} /></Field>
        {error && <div className="text-red-400 text-sm">{error}</div>}
        <div className="flex gap-3 justify-end">
          <button type="button" onClick={onCancel} className="px-4 py-2 text-sm text-gray-400 hover:text-white">Cancel</button>
          <button type="submit" disabled={loading} className="px-5 py-2 text-sm bg-blue-600 hover:bg-blue-700 rounded-lg text-white disabled:opacity-50">
            {loading ? "Adding..." : "Add Account"}
          </button>
        </div>
      </form>
    </div>
  );
}

function NotificationsTab() {
  const [config, setConfig] = useState<NotificationConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const ALL_EVENTS = ["task.completed", "task.failed", "workflow.completed", "workflow.failed", "node.failed"];

  const load = async () => {
    try {
      const data = await notificationsApi.get();
      setConfig(data);
    } catch {}
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    try {
      await notificationsApi.update(config);
      setFeedback("Saved");
      setTimeout(() => setFeedback(null), 1500);
    } catch (err: any) {
      setFeedback(`Error: ${err.response?.data?.error || "Failed"}`);
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    try {
      await notificationsApi.test();
      setFeedback("Test notification sent");
      setTimeout(() => setFeedback(null), 2000);
    } catch (err: any) {
      setFeedback(`Error: ${err.response?.data?.error || "Failed"}`);
    }
  };

  const toggleEvent = (event: string) => {
    if (!config) return;
    const events = config.events.includes(event)
      ? config.events.filter((e) => e !== event)
      : [...config.events, event];
    setConfig({ ...config, events });
  };

  if (loading) return <div className="text-gray-600 text-sm">Loading...</div>;
  if (!config) return <div className="text-gray-600 text-sm">Failed to load notification config</div>;

  return (
    <Section title="Discord Notifications">
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(e) => setConfig({ ...config, enabled: e.target.checked })}
              className="accent-blue-500"
            />
            <span className="text-sm text-gray-300">Enable notifications</span>
          </label>
          {feedback && <span className="text-xs text-green-400">{feedback}</span>}
        </div>

        <Field label="Discord Webhook URL">
          <input
            type="text"
            value={config.discord_webhook_url || ""}
            onChange={(e) => setConfig({ ...config, discord_webhook_url: e.target.value })}
            placeholder="https://discord.com/api/webhooks/..."
            className={inputCls}
          />
        </Field>

        <div>
          <label className="text-xs text-gray-500 font-medium block mb-2">Events to notify</label>
          <div className="grid grid-cols-2 gap-2">
            {ALL_EVENTS.map((event) => (
              <label key={event} className="flex items-center gap-2 cursor-pointer text-sm text-gray-300">
                <input
                  type="checkbox"
                  checked={config.events.includes(event)}
                  onChange={() => toggleEvent(event)}
                  className="accent-blue-500"
                />
                {event}
              </label>
            ))}
          </div>
        </div>

        <div className="flex gap-3">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 rounded-lg text-white disabled:opacity-50 transition-colors"
          >
            {saving ? "Saving..." : "Save"}
          </button>
          <button
            onClick={handleTest}
            className="px-4 py-2 text-sm bg-gray-800 border border-gray-700 hover:border-gray-600 rounded-lg text-gray-300 hover:text-white transition-colors"
          >
            Send Test
          </button>
        </div>
      </div>
    </Section>
  );
}

interface BackupInfo {
  filename: string;
  size_bytes?: number;
  created_at?: string;
}

function BackupTab() {
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [backing, setBacking] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const data = await adminApi.listBackups();
      setBackups(Array.isArray(data) ? data : data.backups || []);
      setError(null);
    } catch {
      setError("Backup list unavailable");
      setBackups([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  const showFeedback = (msg: string) => {
    setFeedback(msg);
    setTimeout(() => setFeedback(null), 3000);
  };

  const handleBackup = async () => {
    setBacking(true);
    try {
      const r = await adminApi.backup();
      showFeedback(`Backup created: ${r.filename || "done"}`);
      load();
    } catch (err: any) {
      setFeedback(`Error: ${err.response?.data?.error || "Backup failed"}`);
    } finally {
      setBacking(false);
    }
  };

  const handleRestore = async (filename: string) => {
    if (!confirm(`Restore backup "${filename}"?\n\nThis will overwrite all current data. This cannot be undone.`)) return;
    setRestoring(filename);
    try {
      await adminApi.restore(filename);
      showFeedback(`Restored from ${filename}`);
    } catch (err: any) {
      setFeedback(`Error: ${err.response?.data?.error || "Restore failed"}`);
    } finally {
      setRestoring(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-semibold text-gray-300">Backup & Restore</h2>
        {feedback && (
          <span className={`text-xs ${feedback.startsWith("Error") ? "text-red-400" : "text-green-400"}`}>
            {feedback}
          </span>
        )}
        <button
          onClick={handleBackup}
          disabled={backing}
          className="ml-auto px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 rounded-lg text-white disabled:opacity-50 transition-colors"
        >
          {backing ? "Creating..." : "Create Backup"}
        </button>
      </div>

      {error && (
        <div className="bg-red-900/20 border border-red-800/50 rounded-xl p-3 text-red-400 text-sm">
          {error}
        </div>
      )}

      <Section title="Backups">
        {loading ? (
          <p className="text-gray-600 text-sm">Loading...</p>
        ) : backups.length === 0 ? (
          <p className="text-gray-600 text-sm">No backups available</p>
        ) : (
          <div className="space-y-2">
            {backups.map((b) => (
              <div key={b.filename} className="flex items-center gap-3 bg-gray-800/50 rounded-lg px-3 py-2.5">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-300 font-mono truncate">{b.filename}</p>
                  <div className="flex items-center gap-2 mt-0.5 text-xs text-gray-600">
                    {b.size_bytes && (
                      <span>{(b.size_bytes / 1024 / 1024).toFixed(1)} MB</span>
                    )}
                    {b.created_at && (
                      <>
                        <span>·</span>
                        <span title={new Date(b.created_at).toLocaleString()}>
                          {formatTimeAgo(b.created_at)}
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => handleRestore(b.filename)}
                  disabled={restoring === b.filename}
                  className="px-3 py-1.5 text-xs bg-orange-900/30 hover:bg-orange-900/60 border border-orange-900/50 rounded text-orange-400 hover:text-orange-300 disabled:opacity-50 transition-colors"
                >
                  {restoring === b.filename ? "Restoring..." : "Restore"}
                </button>
              </div>
            ))}
          </div>
        )}
      </Section>

      <p className="text-xs text-gray-600">
        Backups are auto-refreshed every 15s. Restoring a backup will overwrite all current data.
      </p>
    </div>
  );
}

function StallTab() {
  const [config, setConfig] = useState<StallConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const load = async () => {
    try {
      const data = await configApi.getStall();
      setConfig(data);
    } catch {}
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    try {
      await configApi.updateStall(config);
      setFeedback("Saved");
      setTimeout(() => setFeedback(null), 1500);
    } catch {}
    setSaving(false);
  };

  if (loading) return <div className="text-gray-600 text-sm">Loading...</div>;
  if (!config) return <div className="text-gray-600 text-sm">Failed to load stall config</div>;

  return (
    <Section title="Stall Detection">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(e) => setConfig({ ...config, enabled: e.target.checked })}
              className="accent-blue-500"
            />
            <span className="text-sm text-gray-300">Enable stall detection</span>
          </label>
          {feedback && <span className="text-xs text-green-400">{feedback}</span>}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Field label="No-progress timeout (min)">
            <input
              type="number"
              min={1}
              value={config.no_progress_timeout_min}
              onChange={(e) => setConfig({ ...config, no_progress_timeout_min: parseInt(e.target.value) || 1 })}
              className={inputCls}
            />
          </Field>
          <Field label="GPU idle threshold (%)">
            <input
              type="number"
              min={1}
              max={100}
              value={config.gpu_idle_threshold_pct}
              onChange={(e) => setConfig({ ...config, gpu_idle_threshold_pct: parseInt(e.target.value) || 1 })}
              className={inputCls}
            />
          </Field>
          <Field label="GPU idle timeout (min)">
            <input
              type="number"
              min={1}
              value={config.gpu_idle_timeout_min}
              onChange={(e) => setConfig({ ...config, gpu_idle_timeout_min: parseInt(e.target.value) || 1 })}
              className={inputCls}
            />
          </Field>
        </div>

        <p className="text-xs text-gray-600">
          Tasks will be flagged as stalled if no progress is reported for {config.no_progress_timeout_min} minutes,
          or if GPU utilization stays below {config.gpu_idle_threshold_pct}% for {config.gpu_idle_timeout_min} minutes.
        </p>

        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 rounded-lg text-white disabled:opacity-50 transition-colors"
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </Section>
  );
}
