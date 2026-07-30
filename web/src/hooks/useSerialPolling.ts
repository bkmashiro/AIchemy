import { useEffect, useRef } from "react";

/**
 * Poll without overlapping requests. Hidden tabs pause; cleanup aborts in-flight work.
 */
export function useSerialPolling(
  poll: (signal: AbortSignal) => Promise<unknown> | void,
  intervalMs: number,
  refreshKey: string | number = "",
): void {
  const pollRef = useRef(poll);
  pollRef.current = poll;

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;

    const schedule = () => {
      if (stopped) return;
      timer = setTimeout(run, intervalMs);
    };
    const run = async () => {
      if (stopped) return;
      if (document.visibilityState === "hidden") {
        schedule();
        return;
      }
      controller = new AbortController();
      try {
        await pollRef.current(controller.signal);
      } catch {
        // Callers own visible error state; polling itself must keep running.
      } finally {
        controller = undefined;
        schedule();
      }
    };
    const onVisibility = () => {
      if (document.visibilityState !== "visible" || stopped) return;
      if (timer) clearTimeout(timer);
      timer = undefined;
      void run();
    };

    document.addEventListener("visibilitychange", onVisibility);
    void run();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs, refreshKey]);
}
