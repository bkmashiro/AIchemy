import { useState, useEffect, useCallback, lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, NavLink } from "react-router-dom";
import { useSocket } from "./hooks/useSocket";
import { hasToken, setOnAuthFail, clearToken } from "./lib/api";
import { isActiveTaskStatus } from "./lib/taskStatus";
import LoginPage from "./pages/LoginPage";

const Dashboard = lazy(() => import("./pages/Dashboard"));
const GridView = lazy(() => import("./pages/GridView"));
const Resources = lazy(() => import("./pages/Resources"));
const GridsPage = lazy(() => import("./pages/GridsPage"));
const TasksPage = lazy(() => import("./pages/TasksPage"));
const TaskDetailPage = lazy(() => import("./pages/TaskDetailPage"));
const StubDetailPage = lazy(() => import("./pages/StubDetail"));
const StubsPage = lazy(() => import("./pages/StubsPage"));
const ExperimentsPage = lazy(() => import("./pages/ExperimentsPage"));
const DeployPage = lazy(() => import("./pages/DeployPage"));
const ExperimentLineageDemo = lazy(() => import("./pages/ExperimentLineageDemo"));

function RouteFallback() {
  return (
    <div className="flex items-center justify-center py-16 text-sm text-gray-500">
      Loading…
    </div>
  );
}

function DemoFallback() {
  return (
    <div className="min-h-screen bg-gray-950 text-gray-500 flex items-center justify-center text-sm">
      Loading lineage demo…
    </div>
  );
}

function NavItem({ to, label, badge, end }: { to: string; label: string; badge?: number; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
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
        <span className="bg-blue-600/80 text-white text-xs rounded-full px-1.5 py-0.5 min-w-[18px] text-center leading-none">
          {badge}
        </span>
      )}
    </NavLink>
  );
}

function AppInner(_props: { onLogout: () => void }) {
  const { stubs, globalQueue, connected, lossHistory, logBuffers, socket } = useSocket();

  const runningCount = stubs.reduce(
    (n, s) => n + s.tasks.filter((t) => t.status === "running").length,
    0
  );
  const pendingCount = globalQueue.filter((t) => isActiveTaskStatus(t.status)).length;
  const onlineCount = stubs.filter((s) => s.status === "online").length;

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col">
      <header className="bg-gray-900 border-b border-gray-800 px-4 flex items-center gap-1 h-12 shrink-0">
        <div className="flex items-center gap-2 mr-4">
          <span className="text-lg">&#9878;&#65039;</span>
          <span className="font-bold text-white tracking-tight">Alchemy</span>
          <span className="text-gray-600 text-xs">v2.1</span>
        </div>

        <nav className="flex items-center gap-1 flex-1">
          <NavItem to="/" label="Dashboard" end />
          <NavItem to="/tasks" label="Tasks" />
          <NavItem to="/stubs" label="Stubs" />
          <NavItem to="/grids" label="Grids" />
          <NavItem to="/experiments" label="Experiments" />
          <NavItem to="/resources" label="Resources" />
          <NavItem to="/deploy" label="Deploy" />
        </nav>

        <div className="flex items-center gap-3 ml-4">
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-gray-500">{onlineCount} stub{onlineCount !== 1 ? "s" : ""}</span>
            <span className="text-gray-700">·</span>
            <span className={runningCount > 0 ? "text-blue-400" : "text-gray-500"}>
              {runningCount} running
            </span>
            {pendingCount > 0 && (
              <>
                <span className="text-gray-700">·</span>
                <span className="text-yellow-400">{pendingCount} pending</span>
              </>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <div
              className={`w-1.5 h-1.5 rounded-full transition-colors ${
                connected
                  ? "bg-green-400 shadow-[0_0_4px_rgba(74,222,128,0.6)]"
                  : "bg-red-500"
              }`}
            />
            <span className="text-xs text-gray-500">{connected ? "Live" : "Reconnecting"}</span>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-auto">
        <div className="w-full max-w-none p-2 xl:p-3">
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route
                path="/demo/experiments-lineage"
                element={<ExperimentLineageDemo />}
              />
              <Route
                path="/"
                element={
                  <Dashboard
                    stubs={stubs}
                    globalQueue={globalQueue}
                    lossHistory={lossHistory}
                    logBuffers={logBuffers}
                    onTaskUpdate={() => {}}
                  />
                }
              />
              <Route path="/tasks" element={<TasksPage />} />
              <Route path="/tasks/:id" element={<TaskDetailPage />} />
              <Route path="/stubs" element={<StubsPage />} />
              <Route path="/stubs/:id" element={<StubDetailPage socket={socket} />} />
              <Route path="/grids" element={<GridsPage />} />
              <Route path="/grids/:id" element={<GridView />} />
              <Route path="/experiments" element={<ExperimentsPage />} />
              <Route path="/experiments/:id" element={<ExperimentsPage />} />
              <Route path="/deploy" element={<DeployPage />} />
              <Route
                path="/resources"
                element={
                  <Resources
                    stubs={stubs}
                    globalQueue={globalQueue}
                    connected={connected}
                  />
                }
              />
            </Routes>
          </Suspense>
        </div>
      </main>
    </div>
  );
}

export default function App() {
  const [authed, setAuthed] = useState(hasToken());
  const isDemoRoute = window.location.pathname.startsWith("/demo/");

  const logout = useCallback(() => {
    clearToken();
    setAuthed(false);
  }, []);

  // Register global 401 interceptor
  useEffect(() => {
    setOnAuthFail(logout);
  }, [logout]);

  if (isDemoRoute) {
    return (
      <BrowserRouter>
        <Suspense fallback={<DemoFallback />}>
          <Routes>
            <Route path="/demo/experiments-lineage" element={<ExperimentLineageDemo />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    );
  }

  if (!authed) {
    return <LoginPage onAuth={() => setAuthed(true)} />;
  }

  return (
    <BrowserRouter>
      <AppInner onLogout={logout} />
    </BrowserRouter>
  );
}
