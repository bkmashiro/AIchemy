import express from "express";
import { createServer, Server as HttpServer } from "http";
import { Server, Namespace } from "socket.io";
import { io as ioc, Socket as ClientSocket } from "socket.io-client";
import { store } from "../../store";
import { v4 as uuidv4 } from "uuid";
import { Stub, Token } from "../../types";

export interface TestContext {
  httpServer: HttpServer;
  io: Server;
  stubNs: Namespace;
  webNs: Namespace;
  app: express.Express;
  port: number;
  baseUrl: string;
  cleanup: () => Promise<void>;
}

export async function createTestServer(): Promise<TestContext> {
  store.reset();

  const app = express();
  app.use(express.json());
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: { origin: "*" },
    transports: ["websocket"],
  });

  const stubNs = io.of("/stubs");
  const webNs = io.of("/web");

  return new Promise((resolve) => {
    httpServer.listen(0, () => {
      const addr = httpServer.address() as { port: number };
      resolve({
        httpServer,
        io,
        stubNs,
        webNs,
        app,
        port: addr.port,
        baseUrl: `http://127.0.0.1:${addr.port}`,
        cleanup: async () => {
          io.close();
          httpServer.close();
          store.reset();
        },
      });
    });
  });
}

export function createMockStub(overrides?: Partial<Stub>): Stub {
  const id = uuidv4();
  return {
    id,
    name: `test-stub-${id.slice(0, 6)}`,
    hostname: "test-host",
    gpu: { name: "A40", vram_total_mb: 49152, count: 1 },
    status: "online",
    type: "workstation",
    connected_at: new Date().toISOString(),
    last_heartbeat: new Date().toISOString(),
    max_concurrent: 3,
    tasks: [],
    gpu_stats: { timestamp: new Date().toISOString(), gpus: [] },
    token: "test-token",
    missed_heartbeats: 0,
    ...overrides,
  };
}

export function createTestToken(): Token {
  const token: Token = {
    token: `test-${uuidv4().slice(0, 8)}`,
    created_at: new Date().toISOString(),
    label: "test",
  };
  store.addToken(token);
  return token;
}

export function connectStubClient(port: number): ClientSocket {
  return ioc(`http://127.0.0.1:${port}/stubs`, {
    transports: ["websocket"],
    autoConnect: false,
  });
}
