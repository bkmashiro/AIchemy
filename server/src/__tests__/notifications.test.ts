import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { NotificationConfig } from "../types";

/**
 * Notification tests.
 *
 * The module exports module-level singleton state for rate-limiting and failure
 * tracking. Tests must account for accumulated state across calls within the
 * same describe block. We use vi.resetModules() + dynamic re-import to get a
 * fresh instance per describe block.
 */

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const baseConfig: NotificationConfig = {
  enabled: true,
  discord_webhook_url: "https://discord.com/api/webhooks/test/token",
  events: ["task.completed", "task.failed"],
};

beforeEach(() => {
  mockFetch.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

// Helper to import a fresh copy of the module
async function importNotifications() {
  return await import("../notifications");
}

// ─── Basic send tests ─────────────────────────────────────────────────────────

describe("sendDiscordNotification - basic", () => {
  it("does nothing when disabled", async () => {
    const { sendDiscordNotification } = await importNotifications();
    await sendDiscordNotification({ ...baseConfig, enabled: false }, "task.completed", {});
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does nothing when no webhook URL", async () => {
    const { sendDiscordNotification } = await importNotifications();
    await sendDiscordNotification({ ...baseConfig, discord_webhook_url: undefined }, "task.completed", {});
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does nothing for unlisted events", async () => {
    const { sendDiscordNotification } = await importNotifications();
    await sendDiscordNotification(baseConfig, "node.failed", { id: "x" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("sends for listed events", async () => {
    mockFetch.mockResolvedValue({ ok: true, text: async () => "" });
    const { sendDiscordNotification } = await importNotifications();
    await sendDiscordNotification(baseConfig, "task.completed", { id: "t1", name: "train.py" });
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe(baseConfig.discord_webhook_url);
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body);
    expect(body.embeds[0].title).toContain("task.completed");
  });

  it("embed includes red color for failed events", async () => {
    mockFetch.mockResolvedValue({ ok: true, text: async () => "" });
    const { sendDiscordNotification } = await importNotifications();
    await sendDiscordNotification(baseConfig, "task.failed", { id: "t2" });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.embeds[0].color).toBe(0xe74c3c);
  });

  it("embed includes green color for completed events", async () => {
    mockFetch.mockResolvedValue({ ok: true, text: async () => "" });
    const { sendDiscordNotification } = await importNotifications();
    await sendDiscordNotification(baseConfig, "task.completed", { id: "t3" });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.embeds[0].color).toBe(0x2ecc71);
  });

  it("embed includes duration when started_at and finished_at are present", async () => {
    mockFetch.mockResolvedValue({ ok: true, text: async () => "" });
    const { sendDiscordNotification } = await importNotifications();
    const now = Date.now();
    const started_at = new Date(now - 90_000).toISOString(); // 1m 30s ago
    const finished_at = new Date(now).toISOString();
    await sendDiscordNotification(baseConfig, "task.completed", {
      id: "t4",
      started_at,
      finished_at,
    });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const fields: any[] = body.embeds[0].fields;
    const durField = fields.find((f: any) => f.name === "Duration");
    expect(durField).toBeDefined();
    expect(durField.value).toMatch(/\dm/);
  });
});

// ─── Event filtering ──────────────────────────────────────────────────────────

describe("Event filtering", () => {
  it("respects config.events whitelist", async () => {
    mockFetch.mockResolvedValue({ ok: true, text: async () => "" });
    const { sendDiscordNotification } = await importNotifications();
    const cfg = { ...baseConfig, events: ["task.failed"] };

    await sendDiscordNotification(cfg, "task.completed", { id: "t1" });
    expect(mockFetch).not.toHaveBeenCalled();

    await sendDiscordNotification(cfg, "task.failed", { id: "t2" });
    expect(mockFetch).toHaveBeenCalledOnce();
  });
});

// ─── Rate limiting ────────────────────────────────────────────────────────────

describe("Rate limiting", () => {
  it("queues messages when rate limit is exceeded", async () => {
    mockFetch.mockResolvedValue({ ok: true, text: async () => "" });
    const { sendDiscordNotification, getQueueLength } = await importNotifications();

    // Send 6 messages — only 5 should fire immediately (rate limit = 5/min)
    for (let i = 0; i < 6; i++) {
      await sendDiscordNotification(baseConfig, "task.completed", { id: `t${i}` });
    }

    expect(mockFetch).toHaveBeenCalledTimes(5);
    expect(getQueueLength()).toBe(1);
  });

  it("drains queue after rate limit window resets", async () => {
    mockFetch.mockResolvedValue({ ok: true, text: async () => "" });
    const { sendDiscordNotification, getQueueLength } = await importNotifications();

    for (let i = 0; i < 6; i++) {
      await sendDiscordNotification(baseConfig, "task.completed", { id: `t${i}` });
    }

    expect(mockFetch).toHaveBeenCalledTimes(5);
    expect(getQueueLength()).toBe(1);

    // Advance time by 60s to reset the rate limit window and trigger drain
    await vi.advanceTimersByTimeAsync(60_000);

    expect(getQueueLength()).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(6);
  });
});

// ─── Auto-disable after consecutive failures ──────────────────────────────────

describe("Auto-disable after consecutive failures", () => {
  it("disables webhook after 5 consecutive failures", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 429, text: async () => "rate limited" });
    const { sendDiscordNotification, isWebhookDisabled } = await importNotifications();

    for (let i = 0; i < 5; i++) {
      await sendDiscordNotification(baseConfig, "task.failed", { id: `t${i}` });
    }

    expect(isWebhookDisabled(baseConfig.discord_webhook_url!)).toBe(true);
  });

  it("does not send when webhook is disabled", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, text: async () => "error" });
    const { sendDiscordNotification, isWebhookDisabled } = await importNotifications();

    // Trigger 5 failures to disable
    for (let i = 0; i < 5; i++) {
      await sendDiscordNotification(baseConfig, "task.failed", { id: `t${i}` });
    }

    mockFetch.mockClear();
    // Now send another — should be skipped
    await sendDiscordNotification(baseConfig, "task.failed", { id: "t5" });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(isWebhookDisabled(baseConfig.discord_webhook_url!)).toBe(true);
  });

  it("resets failure count on success", async () => {
    const { sendDiscordNotification, isWebhookDisabled } = await importNotifications();

    // 4 failures
    mockFetch.mockResolvedValue({ ok: false, status: 500, text: async () => "error" });
    for (let i = 0; i < 4; i++) {
      await sendDiscordNotification(baseConfig, "task.failed", { id: `t${i}` });
    }

    // 1 success resets the failure count
    mockFetch.mockResolvedValue({ ok: true, text: async () => "" });
    await sendDiscordNotification(baseConfig, "task.failed", { id: "t4" });

    expect(isWebhookDisabled(baseConfig.discord_webhook_url!)).toBe(false);

    // 1 more failure should not disable (count was reset to 0, then incremented to 1)
    mockFetch.mockResolvedValue({ ok: false, status: 500, text: async () => "error" });
    await sendDiscordNotification(baseConfig, "task.failed", { id: "t5" });
    expect(isWebhookDisabled(baseConfig.discord_webhook_url!)).toBe(false);
  });
});
