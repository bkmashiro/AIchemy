import "@testing-library/jest-dom/vitest";
import { beforeEach } from "vitest";

// Node 25 ships a built-in `localStorage` global that throws unless a file
// path is configured; that breaks jsdom-flavored tests because the lookup
// resolves to the Node global instead of the jsdom one. Force-install a
// minimal in-memory shim before any module that touches localStorage loads.
{
  const store = new Map<string, string>();
  const shim: Storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(i: number) {
      return Array.from(store.keys())[i] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: shim,
    configurable: true,
    writable: true,
  });

  beforeEach(() => {
    shim.clear();
  });
}

class ResizeObserverShim implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

Object.defineProperty(globalThis, "ResizeObserver", {
  value: ResizeObserverShim,
  configurable: true,
  writable: true,
});
