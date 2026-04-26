import { useState, useEffect, useCallback } from "react";
import { BrowserRouter, Routes, Route, NavLink } from "react-router-dom";
import { useSocket } from "./hooks/useSocket";
import { hasToken, setOnAuthFail, clearToken } from "./lib/api";
import Dashboard from "./pages/Dashboard";
import GridView from "./pages/GridView";
import Resources from "./pages/Resources";
import GridsPage from "./pages/GridsPage";
import TasksPage from "./pages/TasksPage";
import TaskDetailPage from "./pages/TaskDetailPage";
import StubDetailPage from "./pages/StubDetail";
import ExperimentsPage from "./pages/ExperimentsPage";
import LoginPage from "./pages/LoginPage";

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
  const { stubs, globalQueue, connected, lossHistory, logBuffers } = useSocket();

  const runningCount = stubs.reduce(
    (n, s) => n + s.tasks.filter((t) => t.status === "running").length,
    0
  );
  const pendingCount = globalQueue.filter((t) =>
    ["pending", "queued"].includes(t.status)
  ).length;
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
          <NavItem to="/grids" label="Grids" />
          <NavItem to="/experiments" label="Experiments" />
          <NavItem to="/resources" label="Resources" />
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
        <div className="p-5 max-w-screen-2xl mx-auto">
          <Routes>
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
            <Route path="/stubs/:id" element={<StubDetailPage />} />
            <Route path="/grids" element={<GridsPage />} />
            <Route path="/grids/:id" element={<GridView />} />
            <Route path="/experiments" element={<ExperimentsPage />} />
            <Route path="/experiments/:id" element={<ExperimentsPage />} />
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
        </div>
      </main>
    </div>
  );
}

export default function App() {
  const [authed, setAuthed] = useState(hasToken());

  const logout = useCallback(() => {
    clearToken();
    setAuthed(false);
  }, []);

  // Register global 401 interceptor
  useEffect(() => {
    setOnAuthFail(logout);
  }, [logout]);

  if (!authed) {
    return <LoginPage onAuth={() => setAuthed(true)} />;
  }

  return (
    <BrowserRouter>
      <AppInner onLogout={logout} />
    </BrowserRouter>
  );
}
