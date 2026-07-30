import { Router } from "express";
import { store } from "../store";

export function createOperatorRouter(): Router {
  const router = Router();
  router.get("/config", (_req, res) => {
    res.json({
      state_db_path: store.getStateFile(),
      capacity_capable: true,
    });
  });
  return router;
}
