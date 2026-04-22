import { BrowserRouter, Routes, Route, Link } from "react-router-dom";
import { useSocket } from "./hooks/useSocket";
import Dashboard from "./pages/Dashboard";
import StubDetail from "./pages/StubDetail";
import TaskQueue from "./pages/TaskQueue";

export default function App() {
  const { stubs, connected } = useSocket();

  return (
    <BrowserRouter>
      <div className="min-h-screen flex flex-col">
        <nav className="bg-gray-900 border-b border-gray-800 px-6 py-3 flex items-center gap-6">
          <span className="text-blue-400 font-bold text-lg">⚗️ Alchemy v2</span>
          <Link to="/" className="text-gray-300 hover:text-white transition">Dashboard</Link>
          <Link to="/tasks" className="text-gray-300 hover:text-white transition">Tasks</Link>
          <div className="ml-auto flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${connected ? "bg-green-400" : "bg-red-500"}`} />
            <span className="text-sm text-gray-400">{connected ? "Connected" : "Disconnected"}</span>
          </div>
        </nav>
        <main className="flex-1 p-6">
          <Routes>
            <Route path="/" element={<Dashboard stubs={stubs} />} />
            <Route path="/stubs/:id" element={<StubDetail stubs={stubs} />} />
            <Route path="/tasks" element={<TaskQueue stubs={stubs} />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
