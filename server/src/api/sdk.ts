/**
 * api/sdk.ts — SDK HTTP fallback endpoint.
 *
 * POST /sdk/report — accepts progress/checkpoint/done reports from SDK
 * when Unix socket is unavailable.
 */

import { Router, Request, Response } from "express";
import { store } from "../store";
import { metricsStore } from "../metrics";
import { Namespace } from "socket.io";

export function createSdkRouter(webNs: Namespace): Router {
  const router = Router();

  // POST /sdk/report — no auth; task_id is the credential
  router.post("/report", (req: Request, res: Response) => {
    const { task_id, type, step, total, loss, metrics, path: checkpointPath, config } = req.body;

    if (!task_id) {
      res.status(400).json({ error: "task_id required" });
      return;
    }

    const found = store.findTask(task_id);
    if (!found) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const { task, stubId } = found;

    switch (type) {
      case "progress": {
        const update = {
          progress: {
            step: step ?? 0,
            total: total ?? 0,
            loss,
            metrics,
          },
        };
        let updated;
        if (stubId) {
          updated = store.updateTask(stubId, task_id, update);
        } else {
          updated = store.updateGlobalQueueTask(task_id, update);
        }
        if (updated) {
          webNs.emit("task.update", updated);
          metricsStore.pushTaskMetrics(task_id, step ?? 0, loss, metrics);
        }
        break;
      }
      case "checkpoint": {
        const update = { checkpoint_path: checkpointPath };
        if (stubId) store.updateTask(stubId, task_id, update);
        else store.updateGlobalQueueTask(task_id, update);
        break;
      }
      case "config": {
        const update = { config_snapshot: config };
        if (stubId) store.updateTask(stubId, task_id, update);
        else store.updateGlobalQueueTask(task_id, update);
        break;
      }
      case "done": {
        // SDK reports done — update metrics
        if (metrics && stubId) {
          const updated = store.updateTask(stubId, task_id, {
            progress: {
              ...(task.progress || { step: 0, total: 0 }),
              metrics,
            },
          });
          if (updated) webNs.emit("task.update", updated);
        }
        break;
      }
      case "heartbeat":
        // No-op — just acknowledge
        break;
      default:
        res.status(400).json({ error: `Unknown type '${type}'` });
        return;
    }

    // Return current signals
    const latestFound = store.findTask(task_id);
    const latestTask = latestFound?.task;
    res.json({
      ok: true,
      should_stop: latestTask?.should_stop ?? false,
      should_checkpoint: latestTask?.should_checkpoint ?? false,
    });
  });

  return router;
}
