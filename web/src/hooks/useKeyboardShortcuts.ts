import { useEffect, useRef } from "react";

export function useKeyboardShortcuts(shortcuts: Record<string, () => void>) {
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;

  useEffect(() => {
    let pendingKey: string | null = null;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;

    const handler = (e: KeyboardEvent) => {
      // Don't trigger when typing in inputs
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) return;

      const key = `${e.ctrlKey ? "ctrl+" : ""}${e.metaKey ? "meta+" : ""}${e.key}`;

      // Check for direct shortcut first
      if (shortcutsRef.current[key]) {
        e.preventDefault();
        shortcutsRef.current[key]();
        pendingKey = null;
        if (pendingTimer) clearTimeout(pendingTimer);
        return;
      }

      // Handle chord sequences (e.g. "g d")
      if (pendingKey) {
        const chord = `${pendingKey} ${e.key}`;
        if (shortcutsRef.current[chord]) {
          e.preventDefault();
          shortcutsRef.current[chord]();
        }
        pendingKey = null;
        if (pendingTimer) clearTimeout(pendingTimer);
        return;
      }

      // Start a chord sequence if the key is a prefix
      const isPrefix = Object.keys(shortcutsRef.current).some((k) => k.startsWith(`${e.key} `));
      if (isPrefix) {
        pendingKey = e.key;
        pendingTimer = setTimeout(() => { pendingKey = null; }, 1000);
      }
    };

    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
      if (pendingTimer) clearTimeout(pendingTimer);
    };
  }, []);
}
