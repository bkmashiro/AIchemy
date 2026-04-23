import { BrowserRouter, Routes, Route, NavLink, useNavigate } from "react-router-dom";
import { useState, useRef } from "react";
import { useSocket } from "./hooks/useSocket";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import Dashboard from "./pages/Dashboard";
import StubDetail from "./pages/StubDetail";
import TaskQueue from "./pages/TaskQueue";
import GridsPage from "./pages/GridsPage";
import AlertsPage from "./pages/AlertsPage";
import SettingsPage from "./pages/SettingsPage";
import WorkflowsPage from "./pages/WorkflowsPage";
import MigrationsPage from "./pages/MigrationsPage";
import ComparisonPage from "./pages/ComparisonPage";
import AuditPage from "./pages/AuditPage";
import ShortcutHelp from "./components/ShortcutHelp";
import { alertsApi } from "./lib/api";

function NavItem({ to, label, badge }: { to: string; label: string; badge?: number }) {
  return (
    <NavLink
      to={to}
      end={to === "/"}
      className={({ isActive }) =>
        `flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
          isActive
            ? "bg-blue-600/20 text-blue-400"
            : "text-gray-400 hover:text-white hover:bg-gray-800"
        }`
      }
    >
      {label}
      {badge !== undefined && badge > 0 && (
        <span className="bg-red-600 text-white text-xs rounded-full px-1.5 py-0.5 min-w-[18px] text-center leading-none">
          {badge}
        </span>
      )}
    </NavLink>
  );
}

interface AlertToast {
  id: string;
  type: string;
  message: string;
  stubId: string;
}

function AppInner() {
  const {
    stubs,
    globalQueue,
    connected,
    lossHistory,
    alerts,
    migrationSuggestions,
    resolveAlert,
    dismissMigration,
  } = useSocket();

  const navigate = useNavigate();
  const [toasts, setToasts] = useState<AlertToast[]>([]);
  const [prevAlertIds] = useState(new Set<string>());
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // Show toast for new alerts
  const newAlerts = alerts.filter((a) => !a.resolved && !prevAlertIds.has(a.id));
  newAlerts.forEach((a) => {
    prevAlertIds.add(a.id);
    const toast: AlertToast = { id: a.id, type: a.type, message: a.message, stubId: a.stub_id };
    setToasts((prev) => {
      if (prev.find((t) => t.id === a.id)) return prev;
      const next = [...prev, toast];
      setTimeout(() => setToasts((p) => p.filter((t) => t.id !== a.id)), 6000);
      return next;
    });
  });

  const runningCount = stubs.reduce((n, s) => n + s.tasks.filter((t) => t.status === "running").length, 0);
  const queuedCount = globalQueue.filter((t) => t.status === "queued" || t.status === "waiting").length;
  const onlineCount = stubs.filter((s) => s.status === "online").length;
  const unresolvedAlertCount = alerts.filter((a) => !a.resolved).length;
  const migrationCount = migrationSuggestions.length;

  const handleResolveAlertFromPage = async (id: string) => {
    try {
      await alertsApi.resolve(id);
      resolveAlert(id);
    } catch {}
  };

  // Keyboard shortcuts
  useKeyboardShortcuts({
    "/": () => {
      // Focus search input if available on current page
      const input = document.querySelector<HTMLInputElement>("input[placeholder*='earch']");
      if (input) { input.focus(); input.select(); }
    },
    "?": () => setShowShortcutHelp((v) => !v),
    "Escape": () => setShowShortcutHelp(false),
    "g d": () => navigate("/"),
    "g t": () => navigate("/tasks"),
    "g g": () => navigate("/grids"),
    "g a": () => navigate("/alerts"),
    "g u": () => navigate("/audit"),
    "g s": () => navigate("/settings"),
  });

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col">
      {/* Top navbar */}
      <header className="bg-gray-900 border-b border-gray-800 px-4 flex items-center gap-1 h-12 shrink-0">
        <div className="flex items-center gap-2 mr-4">
          <span className="text-lg">⚗️</span>
          <span className="font-bold text-white tracking-tight">Alchemy</span>
          <span className="text-gray-600 text-xs">v2</span>
        </div>

        <nav className="flex items-center gap-1 flex-1 overflow-x-auto">
          <NavItem to="/" label="Dashboard" />
          <NavItem to="/tasks" label="Tasks" badge={runningCount + queuedCount} />
          <NavItem to="/grids" label="Grids" />
          <NavItem to="/workflows" label="Workflows" />
          <NavItem to="/alerts" label="Alerts" badge={unresolvedAlertCount} />
          <NavItem to="/migrations" label="Migrations" badge={migrationCount} />
          <NavItem to="/compare" label="Compare" />
          <NavItem to="/audit" label="Audit" />
          <NavItem to="/settings" label="Settings" />
        </nav>

        <div className="flex items-center gap-3 ml-4">
          <button
            onClick={() => setShowShortcutHelp(true)}
            className="text-gray-600 hover:text-gray-400 text-xs transition-colors"
            title="Keyboard shortcuts (?)"
          >
            ?
          </button>
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-gray-500">{onlineCount} stub{onlineCount !== 1 ? "s" : ""}</span>
            <span className="text-gray-700">·</span>
            <span className={runningCount > 0 ? "text-green-400" : "text-gray-500"}>
              {runningCount} running
            </span>
            {queuedCount > 0 && (
              <>
                <span className="text-gray-700">·</span>
                <span className="text-yellow-400">{queuedCount} queued</span>
              </>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <div
              className={`w-1.5 h-1.5 rounded-full ${
                connected ? "bg-green-400 shadow-[0_0_4px_rgba(74,222,128,0.6)]" : "bg-red-500"
              }`}
            />
            <span className="text-xs text-gray-500">{connected ? "Live" : "Offline"}</span>
          </div>
        </div>
      </header>

      {/* Alert toasts */}
      {toasts.length > 0 && (
        <div className="fixed top-14 right-4 z-50 flex flex-col gap-2 pointer-events-none">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className="bg-gray-900 border border-red-700/60 rounded-xl px-4 py-3 shadow-2xl pointer-events-auto max-w-sm animate-in slide-in-from-right"
            >
              <div className="flex items-start gap-3">
                <span className="text-red-400 text-lg">⚠</span>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold text-red-400 uppercase tracking-wider">
                    {toast.type.replace(/_/g, " ")}
                  </div>
                  <p className="text-sm text-gray-200 mt-0.5 truncate">{toast.message}</p>
                  <p className="text-xs text-gray-600 mt-0.5">stub: {toast.stubId.slice(0, 8)}</p>
                </div>
                <button
                  onClick={() => setToasts((p) => p.filter((t) => t.id !== toast.id))}
                  className="text-gray-600 hover:text-gray-400 text-xs shrink-0"
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Shortcut help modal */}
      {showShortcutHelp && <ShortcutHelp onClose={() => setShowShortcutHelp(false)} />}

      {/* Main content */}
      <main className="flex-1 overflow-auto" ref={searchRef as any}>
        <div className="p-5 max-w-screen-2xl mx-auto">
          <Routes>
            <Route path="/" element={<Dashboard stubs={stubs} globalQueue={globalQueue} />} />
            <Route path="/stubs/:id" element={<StubDetail stubs={stubs} lossHistory={lossHistory} connected={connected} />} />
            <Route path="/tasks" element={<TaskQueue stubs={stubs} globalQueue={globalQueue} lossHistory={lossHistory} />} />
            <Route path="/grids" element={<GridsPage stubs={stubs} />} />
            <Route path="/workflows" element={<WorkflowsPage />} />
            <Route
              path="/alerts"
              element={
                <AlertsPage
                  realtimeAlerts={alerts}
                  onResolve={handleResolveAlertFromPage}
                />
              }
            />
            <Route
              path="/migrations"
              element={
                <MigrationsPage
                  stubs={stubs}
                  migrationSuggestions={migrationSuggestions}
                  onDismiss={dismissMigration}
                />
              }
            />
            <Route path="/compare" element={<ComparisonPage />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route path="/settings" element={<SettingsPage stubs={stubs} />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppInner />
    </BrowserRouter>
  );
}
