interface Props {
  onClose: () => void;
}

const SHORTCUTS = [
  { keys: ["/"], description: "Focus search" },
  { keys: ["?"], description: "Show this help" },
  { keys: ["g", "d"], description: "Go to Dashboard" },
  { keys: ["g", "t"], description: "Go to Tasks" },
  { keys: ["g", "g"], description: "Go to Grids" },
  { keys: ["g", "a"], description: "Go to Alerts" },
  { keys: ["g", "u"], description: "Go to Audit log" },
  { keys: ["g", "s"], description: "Go to Settings" },
  { keys: ["Escape"], description: "Close modal / deselect" },
];

export default function ShortcutHelp({ onClose }: Props) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-sm shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-white">Keyboard Shortcuts</h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300 text-sm transition-colors"
          >
            ✕
          </button>
        </div>

        <div className="space-y-2">
          {SHORTCUTS.map((s, i) => (
            <div key={i} className="flex items-center justify-between text-sm">
              <span className="text-gray-400">{s.description}</span>
              <span className="flex items-center gap-1">
                {s.keys.map((k, j) => (
                  <span key={j} className="flex items-center gap-1">
                    <kbd className="px-2 py-0.5 text-xs bg-gray-800 border border-gray-700 rounded font-mono text-gray-300">
                      {k}
                    </kbd>
                    {j < s.keys.length - 1 && (
                      <span className="text-gray-600 text-xs">then</span>
                    )}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>

        <p className="text-xs text-gray-600 mt-4">
          Shortcuts are disabled when typing in inputs.
        </p>
      </div>
    </div>
  );
}
