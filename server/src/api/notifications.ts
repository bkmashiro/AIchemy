import { Router, Request, Response } from "express";
import { store } from "../store";
import { sendDiscordNotification, NotificationConfig } from "../notifications";

export function createNotificationsRouter(): Router {
  const router = Router();

  // GET / — get notification config
  router.get("/config", (_req: Request, res: Response) => {
    res.json(store.getNotificationConfig());
  });

  // POST /config — update notification config
  router.post("/config", (req: Request, res: Response) => {
    const cfg = req.body as Partial<NotificationConfig>;
    store.setNotificationConfig(cfg);
    res.json(store.getNotificationConfig());
  });

  // POST /test — send a test notification
  router.post("/test", async (_req: Request, res: Response) => {
    const config = store.getNotificationConfig();
    if (!config.enabled || !config.discord_webhook_url) {
      res.status(400).json({ error: "Notifications not configured or disabled" });
      return;
    }

    // Force-send regardless of events filter
    const testConfig: NotificationConfig = { ...config, events: ["test"] };
    await sendDiscordNotification(testConfig, "test", {
      name: "Test Notification",
      status: "ok",
      id: "test-000",
    });
    res.json({ ok: true });
  });

  return router;
}
