import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSerialPolling } from "../useSerialPolling";

function Harness({ poll }: { poll: (signal: AbortSignal) => Promise<void> }) {
  useSerialPolling(poll, 1000);
  return null;
}

afterEach(() => { vi.useRealTimers(); });

describe("useSerialPolling", () => {
  it("never overlaps requests and aborts the active request on cleanup", async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    const poll = vi.fn((signal: AbortSignal) => new Promise<void>((resolve) => {
      finish = resolve;
      signal.addEventListener("abort", () => resolve(), { once: true });
    }));

    const rendered = render(<Harness poll={poll} />);
    expect(poll).toHaveBeenCalledTimes(1);
    const firstSignal = poll.mock.calls[0][0];

    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(poll).toHaveBeenCalledTimes(1);

    await act(async () => { finish?.(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(poll).toHaveBeenCalledTimes(2);

    const secondSignal = poll.mock.calls[1][0];
    rendered.unmount();
    expect(firstSignal.aborted).toBe(false);
    expect(secondSignal.aborted).toBe(true);
  });
});
