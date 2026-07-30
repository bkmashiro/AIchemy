import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createOperatorRouter } from "../api/operator";

describe("operator configuration", () => {
  it("reports state and capacity capability without credentials", async () => {
    const app = express(); app.use("/operator", createOperatorRouter());
    const response = await request(app).get("/operator/config").expect(200);
    expect(response.body).toMatchObject({ state_db_path: expect.any(String), capacity_capable: true });
    expect(JSON.stringify(response.body).toLowerCase()).not.toContain("token");
  });
});
