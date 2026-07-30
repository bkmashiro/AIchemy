import { Router, type Request, type Response } from "express";
import { store } from "../store";
import type { AliasObjectKind } from "../aliases";

const SUPPORTED_KINDS = new Set<AliasObjectKind>(["task", "experiment"]);

export function createRefsRouter(): Router {
  const router = Router();

  router.get("/:ref", (req: Request, res: Response) => {
    const rawKind = typeof req.query.kind === "string" ? req.query.kind : undefined;
    if (rawKind && !SUPPORTED_KINDS.has(rawKind as AliasObjectKind)) {
      res.status(400).json({ error: "kind must be task or experiment" });
      return;
    }

    const resolved = store.resolveObjectRef(req.params.ref, rawKind as AliasObjectKind | undefined);
    if (!resolved) {
      res.status(404).json({ error: "Reference not found" });
      return;
    }
    res.json(resolved);
  });

  return router;
}
