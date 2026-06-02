import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  Experiment,
  ExperimentDetail,
  ExperimentEvent,
  ExperimentTreeNode,
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
} from "../components/experiments";

// ─── List View ──────────────────────────────────────────────────────────────

function ExperimentsList() {
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [loading, setLoading] = useState(true);

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

  if (loading && experiments.length === 0) {
    return (
      <div className="flex items-center justify-center py-24 text-gray-500">
        Loading experiments...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-white">Experiments</h1>
        <span className="text-xs text-gray-500">{experiments.length} total</span>
      </div>
      <ExperimentListTable experiments={experiments} />
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

  return (
    <div className="space-y-6">
      <ExperimentDetailHeader
        exp={exp}
        onRetryFailed={handleRetry}
        onDelete={handleDelete}
      />

      <ExperimentCriteriaCard criteria={exp.criteria} />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <ExperimentLineageGraphCard
          roots={tree}
          currentId={exp.id}
          onSelectExperiment={(nextId) => navigate(`/experiments/${nextId}`)}
        />
        <ExperimentResearchCallCard exp={exp} summary={summary} />
        <ExperimentConfigDiffCard diff={diff} summary={summary} />
      </div>

      <ExperimentTimelineCard
        experimentId={exp.id}
        events={events}
        onNoteAdded={() => load()}
      />

      <ExperimentMatrixCard exp={exp} />

      <ExperimentTaskTable tasks={exp.tasks ?? []} results={exp.results} />
    </div>
  );
}

// ─── Router entry ───────────────────────────────────────────────────────────

export default function ExperimentsPage() {
  const { id } = useParams<{ id: string }>();
  return id ? <ExperimentDetailView /> : <ExperimentsList />;
}
