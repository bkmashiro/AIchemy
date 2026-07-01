import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  Experiment,
  ExperimentDetail,
  ExperimentEvent,
  ExperimentTreeNode,
  Task,
  ExperimentSummaryResponse,
  ExperimentDiffResponse,
  experimentsApi,
} from "../lib/api";
import {
  IntentCard,
  DecisionCard,
  LineageCard,
  ExperimentListTable,
  ExperimentDetailHeader,
  ExperimentCriteriaCard,
  ExperimentTaskTable,
  ExperimentMatrixCard,
  ExperimentTimelineCard,
  ExperimentLineageGraphCard,
  ExperimentResearchCallCard,
  ExperimentConfigDiffCard,
  ExperimentReviewWorkspace,
  filterExperimentEntryPoints,
} from "../components/experiments";

// ─── List View ──────────────────────────────────────────────────────────────

function ExperimentsList() {
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [loading, setLoading] = useState(true);
  const [familyFilter, setFamilyFilter] = useState<string>("");
  const [decisionFilter, setDecisionFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("");

  useEffect(() => {
    const load = () => {
      experimentsApi
        .list()
        .then(setExperiments)
        .catch(() => {})
        .finally(() => setLoading(false));
    };
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  const families = Array.from(
    new Set(experiments.map((e) => e.family).filter((f): f is string => !!f)),
  ).sort();

  const filtered = experiments.filter((e) => {
    if (familyFilter && (e.family ?? "") !== familyFilter) return false;
    if (decisionFilter) {
      if (decisionFilter === "none" && e.decision) return false;
      if (decisionFilter !== "none" && e.decision !== decisionFilter) return false;
    }
    if (statusFilter && e.status !== statusFilter) return false;
    return true;
  });
  const visibleEntryCount = filterExperimentEntryPoints(filtered).length;

  if (loading && experiments.length === 0) {
    return (
      <div className="flex items-center justify-center py-24 text-gray-500">
        Loading experiments...
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-white">Experiments</h1>
        <span className="text-xs text-gray-500">
          {visibleEntryCount} entry point{visibleEntryCount === 1 ? "" : "s"} · {filtered.length} filtered · {experiments.length} total
        </span>
      </div>
      <div className="flex flex-wrap gap-2 items-center text-xs">
        <select
          value={familyFilter}
          onChange={(e) => setFamilyFilter(e.target.value)}
          className="bg-gray-900 border border-gray-800 rounded px-2 py-1 text-gray-300"
        >
          <option value="">All families</option>
          {families.map((f) => (
            <option key={f} value={f}>{f}</option>
          ))}
        </select>
        <select
          value={decisionFilter}
          onChange={(e) => setDecisionFilter(e.target.value)}
          className="bg-gray-900 border border-gray-800 rounded px-2 py-1 text-gray-300"
        >
          <option value="">All decisions</option>
          <option value="keep">keep</option>
          <option value="try_more">try_more</option>
          <option value="discard">discard</option>
          <option value="none">undecided</option>
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="bg-gray-900 border border-gray-800 rounded px-2 py-1 text-gray-300"
        >
          <option value="">All statuses</option>
          <option value="running">running</option>
          <option value="passed">passed</option>
          <option value="partial">partial</option>
          <option value="failed">failed</option>
        </select>
        {(familyFilter || decisionFilter || statusFilter) && (
          <button
            type="button"
            onClick={() => {
              setFamilyFilter("");
              setDecisionFilter("");
              setStatusFilter("");
            }}
            className="text-gray-500 hover:text-gray-300"
          >
            clear
          </button>
        )}
      </div>
      <ExperimentReviewWorkspace
        familyFilter={familyFilter}
        families={families}
        decisionFilter={decisionFilter}
        statusFilter={statusFilter}
        onSelectFamily={setFamilyFilter}
      />
      <ExperimentListTable experiments={filtered} />
    </div>
  );
}

// ─── Detail View ────────────────────────────────────────────────────────────

function ExperimentDetailView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [exp, setExp] = useState<ExperimentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [events, setEvents] = useState<ExperimentEvent[]>([]);
  const [allExperiments, setAllExperiments] = useState<Experiment[]>([]);
  const [tree, setTree] = useState<ExperimentTreeNode[] | null>(null);
  const [summary, setSummary] = useState<ExperimentSummaryResponse | null>(null);
  const [diff, setDiff] = useState<ExperimentDiffResponse | null>(null);
  const [selectedLineageId, setSelectedLineageId] = useState<string | null>(null);
  const [selectedLineageTasks, setSelectedLineageTasks] = useState<Task[]>([]);
  const [selectedLineageExp, setSelectedLineageExp] = useState<ExperimentDetail | null>(null);
  const [selectedLineageSummary, setSelectedLineageSummary] = useState<ExperimentSummaryResponse | null>(null);
  const [selectedLineageDiff, setSelectedLineageDiff] = useState<ExperimentDiffResponse | null>(null);
  const [selectedLineageEvents, setSelectedLineageEvents] = useState<ExperimentEvent[]>([]);

  const load = () => {
    if (!id) return;
    experimentsApi
      .get(id)
      .then(setExp)
      .catch(() => {})
      .finally(() => setLoading(false));
    experimentsApi
      .getTimeline(id)
      .then((r) => setEvents(r.events))
      .catch(() => {});
    experimentsApi
      .getSummary(id)
      .then(setSummary)
      .catch(() => setSummary(null));
    experimentsApi
      .getDiff(id)
      .then(setDiff)
      .catch(() => setDiff(null));
  };

  useEffect(() => {
    if (id) {
      setSelectedLineageId(id);
      setSelectedLineageExp(null);
      setSelectedLineageSummary(null);
      setSelectedLineageDiff(null);
      setSelectedLineageEvents([]);
      setSelectedLineageTasks([]);
    }
  }, [id]);

  useEffect(() => {
    if (!id || !exp) return;
    if (selectedLineageId !== null && selectedLineageId !== id) return;
    setSelectedLineageTasks(exp.tasks ?? []);
  }, [selectedLineageId, id, exp?.tasks]);

  useEffect(() => {
    if (!id || !exp) return;
    if (!selectedLineageId || selectedLineageId === id) {
      setSelectedLineageExp(null);
      setSelectedLineageSummary(null);
      setSelectedLineageDiff(null);
      setSelectedLineageEvents([]);
      return;
    }

    let cancelled = false;
    setSelectedLineageTasks([]);
    setSelectedLineageExp(null);
    setSelectedLineageSummary(null);
    setSelectedLineageDiff(null);
    setSelectedLineageEvents([]);

    Promise.all([
      experimentsApi.get(selectedLineageId),
      experimentsApi.getSummary(selectedLineageId).catch(() => null),
      experimentsApi.getDiff(selectedLineageId).catch(() => null),
      experimentsApi.getTimeline(selectedLineageId).catch(() => ({ experiment_id: selectedLineageId, events: [] })),
    ])
      .then(([selectedExp, selectedSummary, selectedDiff, selectedTimeline]) => {
        if (cancelled) return;
        setSelectedLineageExp(selectedExp);
        setSelectedLineageTasks(selectedExp.tasks ?? []);
        setSelectedLineageSummary(selectedSummary);
        setSelectedLineageDiff(selectedDiff);
        setSelectedLineageEvents(selectedTimeline.events);
      })
      .catch(() => {
        if (cancelled) return;
        setSelectedLineageTasks([]);
        setSelectedLineageExp(null);
        setSelectedLineageSummary(null);
        setSelectedLineageDiff(null);
        setSelectedLineageEvents([]);
      });


    return () => {
      cancelled = true;
    };
  }, [selectedLineageId, id, exp?.id]);

  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [id]);

  useEffect(() => {
    experimentsApi
      .list()
      .then(setAllExperiments)
      .catch(() => {});
    experimentsApi
      .getTree()
      .then(setTree)
      .catch(() => setTree(null));
  }, [id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-gray-500">
        Loading...
      </div>
    );
  }

  if (!exp) {
    return (
      <div className="flex items-center justify-center py-24 text-red-400">
        Experiment not found
      </div>
    );
  }

  const handleDelete = async () => {
    await experimentsApi.delete(exp.id);
    navigate("/experiments");
  };

  const handleRetry = async () => {
    await experimentsApi.retryFailed(exp.id);
    load();
  };

  const refreshResearchCall = (changedId: string) => {
    load();
    if (!changedId || changedId === exp.id) return;

    const includeTimeline = changedId === selectedLineageId;

    Promise.all([
      experimentsApi.get(changedId),
      experimentsApi.getSummary(changedId).catch(() => null),
      experimentsApi.getDiff(changedId).catch(() => null),
      includeTimeline ? experimentsApi.getTimeline(changedId).catch(() => ({ experiment_id: changedId, events: [] })) : Promise.resolve(null),
    ])
      .then(([selectedExp, selectedSummary, selectedDiff, selectedTimeline]) => {
        setSelectedLineageExp(selectedExp);
        setSelectedLineageTasks(selectedExp.tasks ?? []);
        setSelectedLineageSummary(selectedSummary);
        setSelectedLineageDiff(selectedDiff);
        if (includeTimeline && selectedTimeline) {
          setSelectedLineageEvents(selectedTimeline.events);
        }
      })
      .catch(() => {
        setSelectedLineageTasks([]);
        setSelectedLineageExp(null);
        setSelectedLineageSummary(null);
        setSelectedLineageDiff(null);
        if (includeTimeline) {
          setSelectedLineageEvents([]);
        }
      });
  };

  const previewExp = selectedLineageId && selectedLineageId !== exp.id && selectedLineageExp
    ? selectedLineageExp
    : exp;
  const previewSummary = previewExp.id === exp.id ? summary : selectedLineageSummary;
  const previewDiff = previewExp.id === exp.id ? diff : selectedLineageDiff;
  const previewEvents = previewExp.id === exp.id ? events : selectedLineageEvents;

  return (
    <div className="space-y-3 xl:space-y-2">
      <ExperimentDetailHeader
        exp={exp}
        onRetryFailed={handleRetry}
        onDelete={handleDelete}
      />

      <ExperimentCriteriaCard criteria={exp.criteria} />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <IntentCard exp={exp} />
        <DecisionCard
          exp={exp}
          onUpdated={(u) => {
            setExp({ ...exp, ...u });
            load();
          }}
        />
        <LineageCard exp={exp} allExperiments={allExperiments} />
      </div>

      <section
        aria-label="Research workbench"
        className="grid grid-cols-1 2xl:grid-cols-[minmax(420px,1.35fr)_minmax(360px,1fr)_minmax(320px,0.9fr)] gap-2 xl:gap-3 items-start"
      >
        <section aria-label="Family map" className="min-w-0">
          <ExperimentLineageGraphCard
            roots={tree}
            currentId={selectedLineageId ?? exp.id}
            pageId={exp.id}
            selectedTasks={selectedLineageTasks}
            onSelectExperiment={setSelectedLineageId}
          />
        </section>
        <section aria-label="Research inspector" className="min-w-0 space-y-2">
          <ExperimentResearchCallCard
            exp={previewExp}
            summary={previewSummary}
            recentEvents={previewEvents}
            onChanged={refreshResearchCall}
          />
          <ExperimentConfigDiffCard diff={previewDiff} summary={previewSummary} />
        </section>
        <section aria-label="Experiment evidence" className="min-w-0 space-y-2">
          <ExperimentTimelineCard
            experimentId={previewExp.id}
            events={previewEvents}
            onNoteAdded={() => load()}
          />
          <ExperimentMatrixCard exp={previewExp} />
        </section>
      </section>

      <ExperimentTaskTable tasks={exp.tasks ?? []} results={exp.results} />
    </div>
  );
}

// ─── Router entry ───────────────────────────────────────────────────────────

export default function ExperimentsPage() {
  const { id } = useParams<{ id: string }>();
  return id ? <ExperimentDetailView /> : <ExperimentsList />;
}
