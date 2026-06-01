import { useMemo, useState } from "react";

type DemoDecision = "keep" | "drop" | "rerun" | "fork";
type DemoEventKind = "created" | "forked" | "note" | "decision" | "task_failed" | "resumed" | "metric_best";

type DemoExperiment = {
  id: string;
  name: string;
  status: "running" | "passed" | "partial" | "failed";
  description: string;
  family: string;
  parentId?: string;
  hypothesis: string;
  expected: string;
  forkReason?: string;
  decision?: DemoDecision;
  decisionReason?: string;
  criteria: Record<string, string>;
  config: Record<string, unknown>;
  metrics: Record<string, number>;
};

type DemoEvent = {
  id: string;
  experimentId: string;
  kind: DemoEventKind;
  message: string;
  actor: string;
  age: string;
  data?: Record<string, unknown>;
};

const BADGE: Record<string, string> = {
  running: "bg-blue-900/30 text-blue-400 border-blue-700/40",
  passed: "bg-green-900/30 text-green-400 border-green-700/40",
  partial: "bg-orange-900/30 text-orange-400 border-orange-700/40",
  failed: "bg-red-900/30 text-red-400 border-red-700/40",
  keep: "bg-green-900/30 text-green-400 border-green-700/40",
  drop: "bg-red-900/30 text-red-400 border-red-700/40",
  rerun: "bg-blue-900/30 text-blue-400 border-blue-700/40",
  fork: "bg-purple-900/30 text-purple-400 border-purple-700/40",
  created: "bg-blue-900/30 text-blue-400 border-blue-700/40",
  forked: "bg-purple-900/30 text-purple-400 border-purple-700/40",
  note: "bg-gray-800 text-gray-300 border-gray-700",
  decision: "bg-purple-900/30 text-purple-400 border-purple-700/40",
  task_failed: "bg-red-900/30 text-red-400 border-red-700/40",
  resumed: "bg-amber-900/30 text-amber-400 border-amber-700/40",
  metric_best: "bg-green-900/30 text-green-400 border-green-700/40",
};

const demoExperiments: DemoExperiment[] = [
  {
    id: "baseline",
    name: "jema_v2_baseline_a30",
    status: "partial",
    description: "Baseline JEMA v2 run before curiosity objective changes.",
    family: "jema_v2/pretrain",
    hypothesis: "Stable pretraining should hold zN above 0.82 without loss spikes.",
    expected: "zN >= 0.82, eval loss <= 1.9, no OOM on A30.",
    decision: "fork",
    decisionReason: "Good enough signal, but A30 memory pressure needs a narrower fork.",
    criteria: { zN: ">=0.82", eval_loss: "<=1.90" },
    config: { lr: 0.0003, batch: 64, curiosity: false, stub: "a30-01" },
    metrics: { zN: 0.821, eval_loss: 1.94 },
  },
  {
    id: "curiosity-low-lr",
    name: "jema_v2_curiosity_low_lr",
    status: "running",
    description: "Fork with lower LR and curiosity objective enabled.",
    family: "jema_v2/pretrain",
    parentId: "baseline",
    hypothesis: "Curiosity objective improves zN if LR is reduced enough to avoid collapse.",
    expected: "zN >= 0.86 and smoother loss curve than baseline.",
    forkReason: "Baseline showed usable zN but loss instability after 18k steps.",
    decision: "rerun",
    decisionReason: "Promising zN, but resume on T4 before keeping it.",
    criteria: { zN: ">=0.86", eval_loss: "<=1.80" },
    config: { lr: 0.00018, batch: 48, curiosity: true, stub: "t4-02" },
    metrics: { zN: 0.858, eval_loss: 1.81 },
  },
  {
    id: "curiosity-higher-batch",
    name: "jema_v2_curiosity_higher_batch",
    status: "failed",
    description: "Sibling fork testing whether higher batch fixes gradient noise.",
    family: "jema_v2/pretrain",
    parentId: "baseline",
    hypothesis: "Higher batch reduces variance without hurting zN.",
    expected: "Lower loss variance and no OOM.",
    forkReason: "Baseline variance looked optimizer-related.",
    decision: "drop",
    decisionReason: "OOM twice; not worth more cluster time.",
    criteria: { zN: ">=0.84", eval_loss: "<=1.85" },
    config: { lr: 0.0003, batch: 96, curiosity: true, stub: "a30-03" },
    metrics: { zN: 0.0, eval_loss: 9.99 },
  },
];

const seedEvents: DemoEvent[] = [
  { id: "e1", experimentId: "baseline", kind: "created", message: "Created baseline experiment", actor: "operator", age: "2d ago" },
  { id: "e2", experimentId: "baseline", kind: "metric_best", message: "Best zN reached 0.821 at step 18k", actor: "eval", age: "31h ago", data: { zN: 0.821, step: 18000 } },
  { id: "e3", experimentId: "baseline", kind: "decision", message: "Marked fork: Good enough signal, but A30 memory pressure needs a narrower fork.", actor: "operator", age: "30h ago", data: { decision: "fork" } },
  { id: "e4", experimentId: "curiosity-low-lr", kind: "forked", message: "Forked from jema_v2_baseline_a30", actor: "operator", age: "26h ago", data: { parent: "jema_v2_baseline_a30", lr: "0.0003 -> 0.00018", curiosity: "false -> true" } },
  { id: "e5", experimentId: "curiosity-low-lr", kind: "task_failed", message: "A30 OOM at step 12k", actor: "scheduler", age: "18h ago", data: { stub: "a30-01", exit_code: 137 } },
  { id: "e6", experimentId: "curiosity-low-lr", kind: "resumed", message: "Resumed on t4-02 with batch 48", actor: "operator", age: "16h ago", data: { stub: "t4-02", batch: 48 } },
  { id: "e7", experimentId: "curiosity-low-lr", kind: "decision", message: "Marked rerun: Promising zN, but resume on T4 before keeping it.", actor: "operator", age: "2h ago", data: { decision: "rerun" } },
  { id: "e8", experimentId: "curiosity-higher-batch", kind: "forked", message: "Forked from jema_v2_baseline_a30", actor: "operator", age: "25h ago", data: { batch: "64 -> 96" } },
  { id: "e9", experimentId: "curiosity-higher-batch", kind: "decision", message: "Marked drop: OOM twice; not worth more cluster time.", actor: "operator", age: "20h ago", data: { decision: "drop" } },
];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-gray-600 mb-0.5">{label}</div>
      <div>{children}</div>
    </div>
  );
}

function JsonPill({ data }: { data: Record<string, unknown> }) {
  return (
    <pre className="mt-1 text-[10px] text-gray-600 bg-gray-950/50 rounded px-2 py-1 overflow-x-auto font-mono">
      {JSON.stringify(data)}
    </pre>
  );
}

export default function ExperimentLineageDemo() {
  const [experiments, setExperiments] = useState(demoExperiments);
  const [selectedId, setSelectedId] = useState("curiosity-low-lr");
  const [events, setEvents] = useState(seedEvents);
  const [note, setNote] = useState("");
  const [decision, setDecision] = useState<DemoDecision>("rerun");
  const [reason, setReason] = useState("");

  const selected = experiments.find((e) => e.id === selectedId) ?? experiments[0];
  const parent = selected.parentId ? experiments.find((e) => e.id === selected.parentId) : undefined;
  const forks = experiments.filter((e) => e.parentId === selected.id);
  const timeline = events.filter((e) => e.experimentId === selected.id);

  const diff = useMemo(() => {
    if (!parent) return [];
    const keys = Array.from(new Set([...Object.keys(parent.config), ...Object.keys(selected.config)]));
    return keys
      .map((key) => ({ key, before: parent.config[key], after: selected.config[key] }))
      .filter((row) => JSON.stringify(row.before) !== JSON.stringify(row.after));
  }, [parent, selected]);

  function selectExperiment(id: string) {
    const exp = experiments.find((x) => x.id === id);
    setSelectedId(id);
    setDecision(exp?.decision ?? "keep");
  }

  function addNote() {
    if (!note.trim()) return;
    setEvents((prev) => [
      ...prev,
      {
        id: `local-${prev.length + 1}`,
        experimentId: selected.id,
        kind: "note",
        message: note.trim(),
        actor: "demo-user",
        age: "now",
      },
    ]);
    setNote("");
  }

  function setDemoDecision() {
    if (!reason.trim()) return;
    setExperiments((prev) =>
      prev.map((exp) =>
        exp.id === selected.id
          ? { ...exp, decision, decisionReason: reason.trim() }
          : exp,
      ),
    );
    setEvents((prev) => [
      ...prev,
      {
        id: `local-${prev.length + 1}`,
        experimentId: selected.id,
        kind: "decision",
        message: `Marked ${decision}: ${reason.trim()}`,
        actor: "demo-user",
        age: "now",
        data: { decision },
      },
    ]);
    setReason("");
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <header className="bg-gray-900 border-b border-gray-800 px-5 h-12 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg">⚖️</span>
          <span className="font-bold tracking-tight">Alchemy</span>
          <span className="text-xs text-gray-600">mock lineage demo</span>
        </div>
        <div className="text-xs text-emerald-400">No server · no token · no state</div>
      </header>

      <main className="p-5 max-w-screen-2xl mx-auto space-y-6">
        <section className="flex items-start justify-between gap-4">
          <div>
            <div className="text-xs text-blue-400 mb-2">/demo/experiments-lineage</div>
            <h1 className="text-2xl font-bold">Research lineage demo</h1>
            <p className="text-sm text-gray-500 mt-1 max-w-3xl">
              Static mock data for reviewing the GitLens-style experiment workflow without spinning up Alchemy server, sockets, tokens, tasks, or real cluster state.
            </p>
          </div>
          <select
            value={selectedId}
            onChange={(e) => selectExperiment(e.target.value)}
            className="bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200"
          >
            {experiments.map((exp) => (
              <option key={exp.id} value={exp.id}>{exp.name}</option>
            ))}
          </select>
        </section>

        <section className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-3">
                <h2 className="text-xl font-bold">{selected.name}</h2>
                <span className={`text-xs px-2 py-0.5 rounded border ${BADGE[selected.status]}`}>{selected.status.toUpperCase()}</span>
              </div>
              <p className="text-sm text-gray-500 mt-1">{selected.description}</p>
            </div>
            <div className="flex gap-2">
              {Object.entries(selected.metrics).map(([key, value]) => (
                <div key={key} className="bg-gray-950/60 border border-gray-800 rounded-lg px-3 py-2 text-right">
                  <div className="text-[10px] uppercase tracking-wide text-gray-600">{key}</div>
                  <div className="font-mono text-sm text-gray-200">{value}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <h2 className="text-sm font-medium text-gray-400 mb-3">Intent</h2>
            <div className="space-y-3 text-xs">
              <Field label="Family"><span className="font-mono text-gray-300">{selected.family}</span></Field>
              {parent && <Field label="Parent"><button onClick={() => selectExperiment(parent.id)} className="text-blue-400 hover:text-blue-300 font-mono">{parent.name}</button></Field>}
              <Field label="Hypothesis"><p className="text-gray-300">{selected.hypothesis}</p></Field>
              <Field label="Expected"><p className="text-gray-300">{selected.expected}</p></Field>
              {selected.forkReason && <Field label="Fork reason"><p className="text-gray-300">{selected.forkReason}</p></Field>}
            </div>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <h2 className="text-sm font-medium text-gray-400 mb-3">Decision</h2>
            <div className="space-y-3 text-xs">
              <div>
                <span className={`inline-block text-xs px-2 py-0.5 rounded border ${BADGE[selected.decision ?? "note"]}`}>
                  {(selected.decision ?? "undecided").toUpperCase()}
                </span>
              </div>
              {selected.decisionReason && <p className="text-gray-300">{selected.decisionReason}</p>}
              <div className="space-y-2 pt-2 border-t border-gray-800">
                <div className="flex items-center gap-2">
                  <select value={decision} onChange={(e) => setDecision(e.target.value as DemoDecision)} className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200">
                    <option value="keep">keep</option>
                    <option value="drop">drop</option>
                    <option value="rerun">rerun</option>
                    <option value="fork">fork</option>
                  </select>
                  <button onClick={setDemoDecision} className="px-3 py-1 text-xs rounded bg-blue-600/20 text-blue-400 border border-blue-700/40 hover:bg-blue-600/30">Set</button>
                </div>
                <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason..." rows={2} className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600" />
              </div>
            </div>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <h2 className="text-sm font-medium text-gray-400 mb-3">Lineage</h2>
            <div className="space-y-4 text-xs">
              <div>
                <div className="text-[10px] uppercase tracking-wide text-gray-600 mb-1">Tree</div>
                <div className="space-y-1 font-mono">
                  {experiments.map((exp) => (
                    <button
                      key={exp.id}
                      onClick={() => selectExperiment(exp.id)}
                      className={`block text-left ${exp.id === selected.id ? "text-blue-300" : exp.parentId ? "text-gray-400 ml-5" : "text-gray-300"}`}
                    >
                      {exp.parentId ? "└─ " : "● "}{exp.name}
                    </button>
                  ))}
                </div>
              </div>
              {forks.length > 0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-gray-600 mb-1">Forks ({forks.length})</div>
                  {forks.map((fork) => <button key={fork.id} onClick={() => selectExperiment(fork.id)} className="block text-blue-400 hover:text-blue-300 font-mono">{fork.name}</button>)}
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-medium text-gray-400">Config diff</h2>
              <span className="text-xs text-gray-600">vs parent</span>
            </div>
            {!parent ? (
              <p className="text-xs text-gray-600">Root experiment has no parent diff.</p>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-800 text-gray-600">
                    <th className="text-left py-2">Key</th>
                    <th className="text-left py-2">Parent</th>
                    <th className="text-left py-2">Current</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/50">
                  {diff.map((row) => (
                    <tr key={row.key}>
                      <td className="py-2 font-mono text-gray-400">{row.key}</td>
                      <td className="py-2 font-mono text-red-300">{String(row.before)}</td>
                      <td className="py-2 font-mono text-green-300">{String(row.after)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-medium text-gray-400">Timeline</h2>
              <span className="text-xs text-gray-600">{timeline.length} events</span>
            </div>
            <div className="mb-4 space-y-2 p-3 bg-gray-950/40 border border-gray-800 rounded-lg">
              <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a mock note..." rows={2} className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600" />
              <div className="flex justify-end">
                <button onClick={addNote} className="px-3 py-1 text-xs rounded bg-blue-600/20 text-blue-400 border border-blue-700/40 hover:bg-blue-600/30">Add note</button>
              </div>
            </div>
            <ul className="space-y-2">
              {timeline.map((ev) => (
                <li key={ev.id} className="text-xs border-l-2 border-gray-800 pl-3 py-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`px-1.5 py-0.5 rounded border text-[10px] ${BADGE[ev.kind]}`}>{ev.kind}</span>
                    <span className="text-gray-300">{ev.message}</span>
                    <span className="text-gray-600 ml-auto">{ev.age}</span>
                  </div>
                  <div className="mt-0.5 text-gray-600 text-[11px]">by {ev.actor}</div>
                  {ev.data && <JsonPill data={ev.data} />}
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>
    </div>
  );
}
